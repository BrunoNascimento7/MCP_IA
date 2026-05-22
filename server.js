import express from "express";

/**
 * =========================================================
 * ENV
 * =========================================================
 * Obrigatórias:
 * - OP_KEY
 * - ENV_KEY
 * - COD_SOLICITANTE
 *
 * Opcionais:
 * - DESK_API_HOST (default: https://api.desk.ms)
 * - MCP_BEARER_TOKEN (protege o endpoint /mcp)
 * - ALLOWED_ORIGINS (lista separada por vírgula)
 *
 * Base / FAQ:
 * - FAQ_SOURCE_MODE = remote_json | inline_json
 * - FAQ_JSON_URL
 * - FAQ_DATA_JSON
 * - KB_REFRESH_MS
 */

const PORT = Number(process.env.PORT || 3000);

const OP_KEY = process.env.OP_KEY || "";
const ENV_KEY = process.env.ENV_KEY || "";
const COD_SOLICITANTE = Number(process.env.COD_SOLICITANTE || 289);

const RAW_DESK_API_HOST = process.env.DESK_API_HOST || "https://api.desk.ms";
const DESK_API_BASE = normalizeBaseUrl(RAW_DESK_API_HOST);

const MCP_BEARER_TOKEN = process.env.MCP_BEARER_TOKEN || "";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ===== FAQ / Base =====
const FAQ_SOURCE_MODE = process.env.FAQ_SOURCE_MODE || "remote_json"; // remote_json | inline_json
const FAQ_JSON_URL = process.env.FAQ_JSON_URL || "";
const FAQ_DATA_JSON = process.env.FAQ_DATA_JSON || "";
const KB_REFRESH_MS = Number(process.env.KB_REFRESH_MS || 300000); // 5 min

const app = express();
app.use(express.json({ limit: "2mb" }));

let cachedToken = null;

// cache da base
let knowledgeCache = {
  loadedAt: 0,
  items: [],
};

/**
 * =========================================================
 * HELPERS
 * =========================================================
 */
function normalizeBaseUrl(value) {
  if (!value) return "https://api.desk.ms";
  if (!/^https?:\/\//i.test(value)) {
    return `https://${value}`;
  }
  return value;
}

function ensureEnv() {
  const missing = [];

  if (!OP_KEY) missing.push("OP_KEY");
  if (!ENV_KEY) missing.push("ENV_KEY");
  if (!Number.isFinite(COD_SOLICITANTE)) missing.push("COD_SOLICITANTE");
  if (!DESK_API_BASE) missing.push("DESK_API_HOST");

  if (missing.length) {
    throw new Error(
      `Variáveis de ambiente ausentes ou inválidas: ${missing.join(", ")}`
    );
  }
}

function log(...args) {
  console.log("[MCP]", ...args);
}

function jsonRpcSuccess(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function jsonRpcError(id, code, message, data = undefined) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  };
}

function toolText(text, isError = false) {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

function buildUrl(path) {
  return new URL(path, DESK_API_BASE).toString();
}

async function httpJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();

  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    text,
    json,
  };
}

function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeText(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function tokenize(value = "") {
  return normalizeText(value)
    .split(/[^a-z0-9]+/i)
    .map((t) => t.trim())
    .filter(Boolean);
}

function unique(arr = []) {
  return [...new Set(arr)];
}

function buildSearchBlob(item) {
  return normalizeText(
    [
      item.id,
      item.titulo,
      item.resumo,
      item.conteudo,
      item.tipo,
      ...(Array.isArray(item.palavras_chave) ? item.palavras_chave : []),
      item.url,
      item.fonte,
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function scoreItem(item, query) {
  const terms = unique(tokenize(query));
  if (!terms.length) return 0;

  const titulo = normalizeText(item.titulo || "");
  const resumo = normalizeText(item.resumo || "");
  const conteudo = normalizeText(item.conteudo || "");
  const palavras = normalizeText(
    Array.isArray(item.palavras_chave) ? item.palavras_chave.join(" ") : ""
  );
  const tipo = normalizeText(item.tipo || "");
  const blob = buildSearchBlob(item);

  let score = 0;

  for (const term of terms) {
    if (titulo.includes(term)) score += 8;
    if (resumo.includes(term)) score += 5;
    if (palavras.includes(term)) score += 6;
    if (conteudo.includes(term)) score += 2;
    if (blob.includes(term)) score += 1;
  }

  // bônus por tipo FAQ
  if (tipo.includes("faq")) score += 2;

  return score;
}

/**
 * =========================================================
 * SEGURANÇA DO MCP REMOTO
 * =========================================================
 */
function authMiddleware(req, res, next) {
  if (!MCP_BEARER_TOKEN) return next();

  const auth = req.headers.authorization || "";
  const expected = `Bearer ${MCP_BEARER_TOKEN}`;

  if (auth !== expected) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "Bearer token inválido ou ausente.",
    });
  }

  next();
}

function originMiddleware(req, res, next) {
  if (!ALLOWED_ORIGINS.length) return next();

  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({
      error: "Forbidden",
      message: `Origin não permitida: ${origin}`,
    });
  }

  next();
}

/**
 * =========================================================
 * DESK MANAGER AUTH / API
 * =========================================================
 */
async function getDeskToken() {
  ensureEnv();

  if (cachedToken) {
    return cachedToken;
  }

  const response = await httpJson(buildUrl("/Login/autenticar"), {
    method: "POST",
    headers: {
      Authorization: OP_KEY,
    },
    body: JSON.stringify({
      PublicKey: ENV_KEY,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Erro ao autenticar no Desk Manager (HTTP ${response.status}): ${response.text}`
    );
  }

  const dados = response.json || {};
  const token =
    dados.token ||
    dados.access_token ||
    (typeof dados === "string" ? dados : null);

  if (!token || dados.erro) {
    throw new Error(`Falha ao obter token: ${response.text}`);
  }

  cachedToken = typeof token === "string" ? token : JSON.stringify(token);
  return cachedToken;
}

async function deskAPI(method, path, body = null) {
  const token = await getDeskToken();

  let response = await httpJson(buildUrl(path), {
    method,
    headers: {
      Authorization: token,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 401 || response.status === 403) {
    cachedToken = null;
    const retryToken = await getDeskToken();

    response = await httpJson(buildUrl(path), {
      method,
      headers: {
        Authorization: retryToken,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  return response;
}

/**
 * =========================================================
 * BASE / FAQ
 * =========================================================
 * Formato esperado do catálogo:
 * [
 *   {
 *     "id": "faq-001",
 *     "titulo": "Troca de senha",
 *     "resumo": "Passo a passo para redefinir senha.",
 *     "conteudo": "1. Acesse ... 2. Clique ...",
 *     "tipo": "FAQ",
 *     "palavras_chave": ["senha", "acesso", "login"],
 *     "url": "https://...",
 *     "fonte": "Desk Manager",
 *     "ativo": true
 *   }
 * ]
 */

async function loadKnowledgeBase() {
  const now = Date.now();

  if (
    knowledgeCache.items.length &&
    now - knowledgeCache.loadedAt < KB_REFRESH_MS
  ) {
    return knowledgeCache.items;
  }

  let items = [];

  if (FAQ_SOURCE_MODE === "inline_json") {
    if (!FAQ_DATA_JSON) {
      knowledgeCache = { loadedAt: now, items: [] };
      return [];
    }

    items = safeJsonParse(FAQ_DATA_JSON, []);
  } else if (FAQ_SOURCE_MODE === "remote_json") {
    if (!FAQ_JSON_URL) {
      knowledgeCache = { loadedAt: now, items: [] };
      return [];
    }

    const response = await httpJson(FAQ_JSON_URL, { method: "GET" });

    if (!response.ok) {
      throw new Error(
        `Erro ao carregar FAQ/base (HTTP ${response.status}): ${response.text}`
      );
    }

    items = Array.isArray(response.json) ? response.json : [];
  } else {
    items = [];
  }

  items = items
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      id: String(item.id || ""),
      titulo: String(item.titulo || ""),
      resumo: String(item.resumo || ""),
      conteudo: String(item.conteudo || ""),
      tipo: String(item.tipo || "Artigo"),
      palavras_chave: Array.isArray(item.palavras_chave)
        ? item.palavras_chave.map((p) => String(p))
        : [],
      url: item.url ? String(item.url) : "",
      fonte: item.fonte ? String(item.fonte) : "Base de Conhecimento",
      ativo: item.ativo !== false,
    }))
    .filter((item) => item.id && item.titulo && item.ativo);

  knowledgeCache = {
    loadedAt: now,
    items,
  };

  return items;
}

async function searchKnowledge(query, options = {}) {
  const {
    limit = 5,
    onlyFaq = false,
    onlyArticles = false,
  } = options;

  const base = await loadKnowledgeBase();
  const normalizedQuery = String(query || "").trim();

  if (!normalizedQuery) return [];

  let filtered = base;

  if (onlyFaq) {
    filtered = filtered.filter((item) =>
      normalizeText(item.tipo).includes("faq")
    );
  }

  if (onlyArticles) {
    filtered = filtered.filter(
      (item) => !normalizeText(item.tipo).includes("faq")
    );
  }

  const scored = filtered
    .map((item) => ({
      ...item,
      score: scoreItem(item, normalizedQuery),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Number(limit || 5));

  return scored;
}

async function getKnowledgeById(id) {
  const base = await loadKnowledgeBase();
  return base.find((item) => item.id === id) || null;
}

/**
 * =========================================================
 * TOOLS
 * =========================================================
 */
const TOOLS = [
  {
    name: "criar_chamado",
    description: "Cria um novo chamado no Desk Manager",
    inputSchema: {
      type: "object",
      properties: {
        titulo: {
          type: "string",
          description: "Título do chamado",
        },
        descricao: {
          type: "string",
          description: "Descrição detalhada",
        },
        prioridade_id: {
          type: "number",
          description: "1=Crítica 2=Alta 3=Média 4=Baixa",
        },
      },
      required: ["titulo", "descricao"],
    },
  },
  {
    name: "listar_chamados",
    description: "Lista os chamados no Desk Manager",
    inputSchema: {
      type: "object",
      properties: {
        pesquisa: {
          type: "string",
          description: "Texto para filtrar chamados (opcional)",
        },
        data_criacao: {
          type: "string",
          description:
            "Filtrar por data de criação no formato YYYY-MM-DD (opcional)",
        },
        ativo: {
          type: "string",
          description:
            "Filtro de status: Todos, EmAberto, Favoritos, NaFila, MeusChamados, ou código do status (opcional). Padrão: EmAberto",
        },
      },
    },
  },
  {
    name: "buscar_chamado",
    description: "Busca um chamado pelo ID",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "ID do chamado",
        },
      },
      required: ["id"],
    },
  },

  // ===== FAQ / Base =====
  {
    name: "buscar_faq",
    description:
      "Busca perguntas frequentes e respostas relacionadas ao problema informado pelo usuário.",
    inputSchema: {
      type: "object",
      properties: {
        consulta: {
          type: "string",
          description: "Texto resumido do problema ou palavras-chave.",
        },
        limite: {
          type: "number",
          description: "Quantidade máxima de resultados.",
        },
      },
      required: ["consulta"],
    },
  },
  {
    name: "buscar_artigos_base",
    description:
      "Busca artigos, procedimentos e processos da Base de Conhecimento relacionados ao problema informado.",
    inputSchema: {
      type: "object",
      properties: {
        consulta: {
          type: "string",
          description: "Texto do problema ou palavras-chave.",
        },
        limite: {
          type: "number",
          description: "Quantidade máxima de resultados.",
        },
      },
      required: ["consulta"],
    },
  },
  {
    name: "obter_artigo_base",
    description:
      "Obtém o conteúdo completo de um artigo ou FAQ da Base de Conhecimento pelo ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Identificador único do artigo ou FAQ.",
        },
      },
      required: ["id"],
    },
  },
];

/**
 * =========================================================
 * REGRAS DAS TOOLS
 * =========================================================
 */
async function runTool(toolName, args = {}) {
  // =========================
  // CHAMADOS
  // =========================
  if (toolName === "criar_chamado") {
    if (!args.titulo || typeof args.titulo !== "string") {
      return toolText("Erro: o campo 'titulo' é obrigatório.", true);
    }

    if (!args.descricao || typeof args.descricao !== "string") {
      return toolText("Erro: o campo 'descricao' é obrigatório.", true);
    }

    const response = await deskAPI("POST", "/Chamados", {
      titulo: args.titulo,
      descricao: args.descricao,
      prioridade_id: args.prioridade_id ?? 4,
      CodSolicitante: COD_SOLICITANTE,
    });

    if (response.ok) {
      const dados = response.json || {};
      const numero =
        dados.id ||
        dados.numero ||
        dados.Ticket_ID ||
        dados.codigo ||
        "";

      return toolText(
        `Chamado criado com sucesso!${
          numero ? " Protocolo: " + numero : ""
        }\nResposta: ${response.text}`
      );
    }

    return toolText(`Erro HTTP ${response.status}:\n${response.text}`, true);
  }

  if (toolName === "listar_chamados") {
    const body = {
      Pesquisa: args.pesquisa || "",
      Ativo: args.ativo || "EmAberto",
      Colunas: {
        Chave: "on",
        CodChamado: "on",
        NomePrioridade: "on",
        DataCriacao: "on",
        HoraCriacao: "on",
        NomeStatus: "on",
        Assunto: "on",
        NomeCompletoSolicitante: "on",
        NomeOperador: "on",
        SobrenomeOperador: "on",
        CodGrupo: "on",
        NomeGrupo: "on",
      },
      Ordem: [{ Coluna: "DataCriacao", Direcao: "false" }],
    };

    if (args.data_criacao) {
      body.DataCriacao = args.data_criacao;
    }

    const response = await deskAPI("POST", "/ChamadosSuporte/lista", body);

    if (response.ok) {
      return toolText(`HTTP ${response.status}:\n${response.text}`);
    }

    return toolText(`Erro HTTP ${response.status}:\n${response.text}`, true);
  }

  if (toolName === "buscar_chamado") {
    if (!args.id || typeof args.id !== "string") {
      return toolText("Erro: o campo 'id' é obrigatório.", true);
    }

    const response = await deskAPI("GET", `/ChamadosSuporte/${args.id}`);

    if (response.ok) {
      return toolText(`HTTP ${response.status}:\n${response.text}`);
    }

    return toolText(`Erro HTTP ${response.status}:\n${response.text}`, true);
  }

  // =========================
  // FAQ / BASE
  // =========================
  if (toolName === "buscar_faq") {
    if (!args.consulta || typeof args.consulta !== "string") {
      return toolText("Erro: o campo 'consulta' é obrigatório.", true);
    }

    const resultados = await searchKnowledge(args.consulta, {
      limit: Number(args.limite || 5),
      onlyFaq: true,
    });

    return toolText(JSON.stringify({ resultados }, null, 2));
  }

  if (toolName === "buscar_artigos_base") {
    if (!args.consulta || typeof args.consulta !== "string") {
      return toolText("Erro: o campo 'consulta' é obrigatório.", true);
    }

    const resultados = await searchKnowledge(args.consulta, {
      limit: Number(args.limite || 5),
      onlyArticles: true,
    });

    return toolText(JSON.stringify({ resultados }, null, 2));
  }

  if (toolName === "obter_artigo_base") {
    if (!args.id || typeof args.id !== "string") {
      return toolText("Erro: o campo 'id' é obrigatório.", true);
    }

    const artigo = await getKnowledgeById(args.id);

    if (!artigo) {
      return toolText(
        `Nenhum artigo/FAQ encontrado para o id '${args.id}'.`,
        true
      );
    }

    return toolText(JSON.stringify(artigo, null, 2));
  }

  return toolText(`Ferramenta desconhecida: ${toolName}`, true);
}

/**
 * =========================================================
 * HEALTH / INFO
 * =========================================================
 */
app.get("/", (req, res) => {
  res.send("MCP Server rodando ✅");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "desk-manager-remote-mcp",
    transport: "streamable-http",
  });
});

/**
 * =========================================================
 * MCP ENDPOINT
 * =========================================================
 */
app.get("/mcp", authMiddleware, originMiddleware, (req, res) => {
  res.json({
    name: "desk-manager-remote-mcp",
    version: "1.1.0",
    endpoint: "/mcp",
    transport: "streamable-http",
    methods: [
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ],
  });
});

app.post("/mcp", authMiddleware, originMiddleware, async (req, res) => {
  const msg = req.body;
  const id = msg?.id ?? null;

  try {
    if (!msg || typeof msg !== "object") {
      return res
        .status(400)
        .json(jsonRpcError(id, -32700, "Parse error", "Payload inválido."));
    }

    const { jsonrpc, method, params } = msg;

    if (jsonrpc !== "2.0") {
      return res
        .status(400)
        .json(
          jsonRpcError(
            id,
            -32600,
            "Invalid Request",
            "jsonrpc deve ser '2.0'."
          )
        );
    }

    if (!method || typeof method !== "string") {
      return res
        .status(400)
        .json(
          jsonRpcError(
            id,
            -32600,
            "Invalid Request",
            "method inválido ou ausente."
          )
        );
    }

    log("method:", method);

    if (method === "initialize") {
      return res.json(
        jsonRpcSuccess(id, {
          protocolVersion: "2025-03-26",
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "desk-manager-remote-mcp",
            version: "1.1.0",
          },
        })
      );
    }

    if (method === "notifications/initialized") {
      return res.status(204).send();
    }

    if (method === "tools/list") {
      return res.json(
        jsonRpcSuccess(id, {
          tools: TOOLS,
        })
      );
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};

      if (!toolName || typeof toolName !== "string") {
        return res
          .status(400)
          .json(
            jsonRpcError(
              id,
              -32602,
              "Invalid params",
              "Nome da ferramenta ausente."
            )
          );
      }

      const result = await runTool(toolName, toolArgs);
      return res.json(jsonRpcSuccess(id, result));
    }

    return res
      .status(404)
      .json(jsonRpcError(id, -32601, "Method not found", method));
  } catch (err) {
    console.error("[MCP][ERROR]", err);

    return res
      .status(500)
      .json(jsonRpcError(id, -32603, "Internal error", err.message));
  }
});

/**
 * =========================================================
 * START
 * =========================================================
 */
app.listen(PORT, () => {
  log(`Servidor remoto rodando na porta ${PORT}`);
});