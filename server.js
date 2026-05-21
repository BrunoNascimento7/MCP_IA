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
 */

const PORT = Number(process.env.PORT || 3000);

const OP_KEY = process.env.OP_KEY || "";
const ENV_KEY = process.env.ENV_KEY || "";
const COD_SOLICITANTE = Number(process.env.COD_SOLICITANTE || 289);

// Pode vir como "api.desk.ms" ou "https://api.desk.ms"
const RAW_DESK_API_HOST = process.env.DESK_API_HOST || "https://api.desk.ms";
const DESK_API_BASE = normalizeBaseUrl(RAW_DESK_API_HOST);

const MCP_BEARER_TOKEN = process.env.MCP_BEARER_TOKEN || "";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();
app.use(express.json({ limit: "1mb" }));

let cachedToken = null;

/**
 * =========================================================
 * HELPERS
 * =========================================================
 */
function normalizeBaseUrl(value) {
  if (!value) return "https://api.desk.ms";

  // Se vier só o host, adiciona https://
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

/**
 * =========================================================
 * SEGURANÇA DO MCP REMOTO
 * =========================================================
 */
function authMiddleware(req, res, next) {
  // Se não definiu token, deixa aberto
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
  // Se não configurou origens, não bloqueia
  if (!ALLOWED_ORIGINS.length) return next();

  const origin = req.headers.origin;

  // Só valida quando Origin vier informado
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

  // Retry simples se o token tiver expirado
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
 * TOOLS
 * =========================================================
 * Mantidas conforme a lógica já existente no seu script local:
 * - criar_chamado
 * - listar_chamados
 * - buscar_chamado
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
          description: "Filtrar por data de criação no formato YYYY-MM-DD (opcional)",
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
];

/**
 * =========================================================
 * REGRAS DAS TOOLS
 * =========================================================
 */
async function runTool(toolName, args = {}) {
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
 * GET /mcp
 * Só retorna metadados simples do endpoint
 */
app.get("/mcp", authMiddleware, originMiddleware, (req, res) => {
  res.json({
    name: "desk-manager-remote-mcp",
    version: "1.0.0",
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

/**
 * POST /mcp
 * Endpoint MCP remoto em JSON-RPC 2.0
 */
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
            version: "1.0.0",
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