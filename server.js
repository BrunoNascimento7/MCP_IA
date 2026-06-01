// =====================================================================
// server.js — Desk Manager Remote MCP (versão unificada)
// ---------------------------------------------------------------------
// Junta o melhor dos dois mundos:
//   • Transporte HTTP remoto (streamable-http) + segurança + base de
//     conhecimento/FAQ  → do servidor remoto atual
//   • Ferramentas completas (operadores, históricos, avaliação técnica),
//     paginação server-side, filtros locais e timeout de rede → do MCP
//     stdio antigo
//
// IMPORTANTE: nenhuma credencial fica no código. Tudo vem de variáveis
// de ambiente. As chaves que estavam hardcoded no MCP antigo devem ser
// CONSIDERADAS COMPROMETIDAS e rotacionadas no Desk Manager.
// =====================================================================

import express from "express";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

/**
 * =========================================================
 * CONFIGURAÇÃO (variáveis de ambiente)
 * =========================================================
 */
const PORT = Number(process.env.PORT || 3000);

// --- Credenciais Desk Manager (OBRIGATÓRIAS) ---
const OP_KEY = process.env.OP_KEY || "";
const ENV_KEY = process.env.ENV_KEY || "";
const COD_SOLICITANTE = Number(process.env.COD_SOLICITANTE || 289);

// --- Hosts da API ---
const RAW_DESK_API_HOST = process.env.DESK_API_HOST || "https://api.desk.ms";
const DESK_API_BASE = normalizeBaseUrl(RAW_DESK_API_HOST);

// Host do formulário web usado para lançar Avaliação Técnica
const RAW_DESK_WEB_HOST = process.env.DESK_WEB_HOST || "https://vocedm.desk.ms";
const DESK_WEB_BASE = normalizeBaseUrl(RAW_DESK_WEB_HOST);

// --- Rede ---
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30000); // 30s
// O Desk Manager historicamente exige rejectUnauthorized:false (cadeia de
// certificado incompleta). Mantemos esse comportamento por padrão, mas é
// configurável: defina DESK_TLS_INSECURE=false quando o cert estiver ok.
const DESK_TLS_INSECURE =
  String(process.env.DESK_TLS_INSECURE ?? "true").toLowerCase() !== "false";
const FAQ_TLS_INSECURE =
  String(process.env.FAQ_TLS_INSECURE ?? "false").toLowerCase() === "true";

// --- Segurança do MCP remoto ---
const MCP_BEARER_TOKEN = process.env.MCP_BEARER_TOKEN || "";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// --- FAQ / Base de Conhecimento ---
const FAQ_SOURCE_MODE = process.env.FAQ_SOURCE_MODE || "remote_json"; // remote_json | inline_json
const FAQ_JSON_URL = process.env.FAQ_JSON_URL || "";
const FAQ_DATA_JSON = process.env.FAQ_DATA_JSON || "";
const KB_REFRESH_MS = Number(process.env.KB_REFRESH_MS || 300000); // 5 min

// --- Protocolo MCP ---
const PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = { name: "desk-manager-remote-mcp", version: "2.0.0" };

const app = express();
app.use(express.json({ limit: "2mb" }));

let cachedToken = null;

// cache da base de conhecimento
let knowledgeCache = {
  loadedAt: 0,
  items: [],
};

/**
 * =========================================================
 * HELPERS GERAIS
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
  return { jsonrpc: "2.0", id, result };
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

function buildWebUrl(path) {
  return new URL(path, DESK_WEB_BASE).toString();
}

function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function formEncode(params) {
  return Object.entries(params)
    .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v))
    .join("&");
}

/**
 * Cliente HTTP unificado (nativo http/https) com timeout, controle de TLS
 * e suporte a body JSON ou form-urlencoded.
 * Retorna { ok, status, text, json }.
 */
function requestRaw(
  method,
  urlStr,
  { headers = {}, body = null, form = null, timeoutMs = REQUEST_TIMEOUT_MS, insecure = false } = {}
) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch {
      return reject(new Error(`URL inválida: ${urlStr}`));
    }

    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;

    const finalHeaders = { ...headers };
    let payload = null;

    if (form) {
      payload = formEncode(form);
      finalHeaders["Content-Type"] = "application/x-www-form-urlencoded";
    } else if (body !== null && body !== undefined) {
      payload = typeof body === "string" ? body : JSON.stringify(body);
      if (!finalHeaders["Content-Type"]) {
        finalHeaders["Content-Type"] = "application/json";
      }
    }

    if (payload != null) {
      finalHeaders["Content-Length"] = Buffer.byteLength(payload);
    }

    const options = {
      method,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers: finalHeaders,
    };
    if (isHttps && insecure) options.rejectUnauthorized = false;

    const req = lib.request(options, (res) => {
      let buf = "";
      res.on("data", (chunk) => (buf += chunk));
      res.on("end", () => {
        let json = null;
        try {
          json = buf ? JSON.parse(buf) : null;
        } catch {
          json = null;
        }
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: buf,
          json,
        });
      });
    });

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(
        new Error(`Timeout ${timeoutMs}ms em ${method} ${urlStr}`)
      );
    });

    if (payload != null) req.write(payload);
    req.end();
  });
}

/**
 * =========================================================
 * HELPERS DE BUSCA (FAQ / Base)
 * =========================================================
 */
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
 * DESK MANAGER — AUTH / API
 * =========================================================
 */
async function getDeskToken() {
  ensureEnv();
  if (cachedToken) return cachedToken;

  const res = await requestRaw("POST", buildUrl("/Login/autenticar"), {
    headers: { Authorization: OP_KEY },
    body: { PublicKey: ENV_KEY },
    insecure: DESK_TLS_INSECURE,
  });

  if (!res.ok) {
    throw new Error(
      `Erro ao autenticar no Desk Manager (HTTP ${res.status}): ${res.text}`
    );
  }

  const parsed = res.json;
  let token = null;

  if (parsed && typeof parsed === "object") {
    if (parsed.erro) {
      throw new Error(`Falha ao obter token: ${res.text}`);
    }
    token = parsed.token || parsed.access_token || null;
  } else if (typeof parsed === "string") {
    token = parsed;
  } else {
    // token devolvido como string crua (sem aspas JSON)
    token = res.text ? res.text.trim().replace(/^"|"$/g, "") : null;
  }

  if (!token) {
    throw new Error(`Falha ao obter token: ${res.text}`);
  }

  cachedToken = typeof token === "string" ? token : JSON.stringify(token);
  return cachedToken;
}

// Chamadas JSON à API principal (api.desk.ms), com retry de token.
async function deskAPI(method, path, body = null) {
  const token = await getDeskToken();

  let res = await requestRaw(method, buildUrl(path), {
    headers: { Authorization: token },
    body,
    insecure: DESK_TLS_INSECURE,
  });

  if (res.status === 401 || res.status === 403) {
    cachedToken = null;
    const retryToken = await getDeskToken();
    res = await requestRaw(method, buildUrl(path), {
      headers: { Authorization: retryToken },
      body,
      insecure: DESK_TLS_INSECURE,
    });
  }

  return res;
}

// Chamadas form-urlencoded ao host web (vocedm.desk.ms) — Avaliação Técnica.
async function deskWebForm(method, path, formData) {
  const token = await getDeskToken();

  let res = await requestRaw(method, buildWebUrl(path), {
    headers: { Authorization: token },
    form: formData,
    insecure: DESK_TLS_INSECURE,
  });

  if (res.status === 401 || res.status === 403) {
    cachedToken = null;
    const retryToken = await getDeskToken();
    res = await requestRaw(method, buildWebUrl(path), {
      headers: { Authorization: retryToken },
      form: formData,
      insecure: DESK_TLS_INSECURE,
    });
  }

  return res;
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
    const res = await requestRaw("GET", FAQ_JSON_URL, {
      insecure: FAQ_TLS_INSECURE,
    });
    if (!res.ok) {
      throw new Error(
        `Erro ao carregar FAQ/base (HTTP ${res.status}): ${res.text}`
      );
    }
    items = Array.isArray(res.json) ? res.json : [];
  } else {
    items = [];
  }

  items = (Array.isArray(items) ? items : [])
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

  knowledgeCache = { loadedAt: now, items };
  return items;
}

async function searchKnowledge(query, options = {}) {
  const { limit = 5, onlyFaq = false, onlyArticles = false } = options;

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

  return filtered
    .map((item) => ({ ...item, score: scoreItem(item, normalizedQuery) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Number(limit || 5));
}

async function getKnowledgeById(id) {
  const base = await loadKnowledgeBase();
  return base.find((item) => item.id === id) || null;
}

/**
 * =========================================================
 * ORQUESTRAÇÃO — AVALIAÇÃO TÉCNICA (alto nível)
 * =========================================================
 * Resolve nome do operador → Chave, CodChamado → Chave, encontra a
 * interação mais recente do operador e lança a avaliação técnica.
 */
async function orchestrateAvaliacao(args) {
  // ---- 1) Resolver nome do operador → Chave ----
  const rOp = await deskAPI("POST", "/Operadores/lista", {
    Colunas: {
      Chave: "on",
      Nome: "on",
      Sobrenome: "on",
      Email: "on",
      OnOff: "on",
      GrupoPrincipal: "on",
      EmailGrupo: "on",
      CodGrupo: "on",
    },
    Pesquisa: args.nome_operador,
    Ativo: "S",
    Filtro: {
      Ramal: [""],
      GrupoPrincipal: [""],
      Perfil: [""],
      Online: [""],
      LicencaDMS: [""],
      LicencaCHAT: [""],
      LicencaRCS: [""],
      LicencaFornecedor: [""],
    },
    Ordem: [{ Coluna: "Nome", Direcao: "true" }],
  });

  if (!rOp.ok) {
    return `[1/4] Falha ao buscar operador: HTTP ${rOp.status}\n${rOp.text}`;
  }
  const opData = rOp.json || safeJsonParse(rOp.text, null);
  if (!opData) {
    return `[1/4] Resposta inválida ao buscar operador:\n${rOp.text}`;
  }

  const termo = String(args.nome_operador).toLowerCase().trim();
  const operadores = (opData.root || []).filter((o) => {
    const nomeCompleto = `${o.Nome || ""} ${o.Sobrenome || ""}`.toLowerCase();
    return nomeCompleto.includes(termo);
  });

  if (operadores.length === 0) {
    return `[1/4] Nenhum operador encontrado com nome "${args.nome_operador}".`;
  }
  if (operadores.length > 1) {
    const lista = operadores
      .map(
        (o) =>
          `  - Chave ${o.Chave}: ${o.Nome} ${o.Sobrenome || ""} (${
            o.GrupoPrincipal || ""
          })`
      )
      .join("\n");
    return `[1/4] Ambiguidade — ${operadores.length} operadores encontrados:\n${lista}\nRefine o nome ou chame lancar_avaliacao direto com a Chave.`;
  }
  const operador = operadores[0];
  const chaveOperador = operador.Chave;

  // ---- 2) Resolver CodChamado → Chave ----
  const rCham = await deskAPI("POST", "/ChamadosSuporte/lista", {
    Pesquisa: args.cod_chamado,
    Ativo: "Todos",
    Colunas: { Chave: "on", CodChamado: "on", NomeStatus: "on" },
    Ordem: [{ Coluna: "DataCriacao", Direcao: "false" }],
    StartRow: 0,
    EndRow: 2000,
  });

  if (!rCham.ok) {
    return `[2/4] Falha ao buscar chamado: HTTP ${rCham.status}\n${rCham.text}`;
  }
  const chamData = rCham.json || safeJsonParse(rCham.text, null);
  if (!chamData) {
    return `[2/4] Resposta inválida ao buscar chamado:\n${String(
      rCham.text
    ).substring(0, 2000)}`;
  }
  const chamado = (chamData.root || []).find(
    (c) => c.CodChamado === args.cod_chamado
  );
  if (!chamado) {
    return `[2/4] Chamado ${args.cod_chamado} não encontrado (procurei nos primeiros 2000 com Ativo=Todos).`;
  }
  const chaveChamado = chamado.Chave;

  // ---- 3) Buscar histórico da interação do operador ----
  const rHist = await deskAPI("POST", "/ChamadoHistoricos/lista", {
    Chave: String(chaveChamado),
    CodChamado: "",
    Solicitante: "N",
    Colunas: {
      Chave: "on",
      Descricao: "on",
      Status: "on",
      Aberto: "on",
      DataCriacao: "on",
      HoraCriacao: "on",
      DataAcao: "on",
      Operador: "on",
    },
  });

  if (!rHist.ok) {
    return `[3/4] Falha ao listar históricos: HTTP ${rHist.status}\n${rHist.text}`;
  }
  const histData = rHist.json || safeJsonParse(rHist.text, null);
  if (!histData) {
    return `[3/4] Resposta inválida ao listar históricos:\n${String(
      rHist.text
    ).substring(0, 2000)}`;
  }

  const candidatos = (histData.root || []).filter((h) => {
    const ops = h.Operador || [];
    return ops.some((o) => String(o.id) === String(chaveOperador));
  });
  if (candidatos.length === 0) {
    return `[3/4] Nenhuma interação de "${operador.Nome} ${
      operador.Sobrenome || ""
    }" (Chave ${chaveOperador}) no chamado ${args.cod_chamado} (Chave ${chaveChamado}).\nTotal de interações no chamado: ${
      (histData.root || []).length
    }`;
  }
  candidatos.sort((a, b) => {
    const dA = `${a.DataCriacao || ""} ${a.HoraCriacao || ""}`;
    const dB = `${b.DataCriacao || ""} ${b.HoraCriacao || ""}`;
    return dB.localeCompare(dA);
  });
  const hist = candidatos[0];

  // ---- 4) Lançar avaliação ----
  const dados = {
    TAvaliacaoTecnica: {
      Chave: "",
      ChaveOperador: "",
      OperadorAvaliadoGrupo: "",
      QuemAvaliouGrupo: "",
      DataInteracao: "",
      HoraInteracao: "",
      DataAvaliacao: "",
      HoraAvaliacao: "",
      Operador: String(chaveOperador),
      Chamado: String(chaveChamado),
      DescricaoDaAcao: "",
      NumeroAcao: "",
      CodAvaliacao: String(args.cod_avaliacao),
      Descricao: args.descricao || "",
      Sugestao: args.sugestao || "",
      LimparDS: "off",
    },
    THist: { Chave: String(hist.Chave) },
  };
  const formData = {
    Dados: JSON.stringify(dados),
    Menu: "AvaliacaoTecnica",
    App: "EvaluationService",
  };
  const rAval = await deskWebForm("PUT", "/AvaliacaoTecnica", formData);

  return [
    `Resolução:`,
    `  Operador  : ${operador.Nome} ${operador.Sobrenome || ""} (Chave ${chaveOperador})`,
    `  Chamado   : ${args.cod_chamado} (Chave ${chaveChamado})`,
    `  Histórico : Chave ${hist.Chave} — ${hist.DataCriacao || "?"} ${hist.HoraCriacao || "?"}`,
    `  Nota      : ${args.cod_avaliacao}`,
    ``,
    `Resposta da API:`,
    `HTTP ${rAval.status}`,
    rAval.text,
  ].join("\n");
}

/**
 * =========================================================
 * DEFINIÇÃO DAS TOOLS
 * =========================================================
 */
const TOOLS = [
  // ===== Chamados =====
  {
    name: "criar_chamado",
    description: "Cria um novo chamado no Desk Manager",
    inputSchema: {
      type: "object",
      properties: {
        titulo: { type: "string", description: "Título do chamado" },
        descricao: { type: "string", description: "Descrição detalhada" },
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
    description:
      "Lista os chamados no Desk Manager. Suporta paginação server-side e filtros locais por Chave/CodChamado.",
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
            "Filtro de status: Todos, EmAberto, Favoritos, NaFila, MeusChamados, ou código do status. Padrão: EmAberto",
        },
        chave: {
          type: "string",
          description:
            "Filtro LOCAL: buscar uma Chave numérica específica (ex: 92157)",
        },
        cod_chamado: {
          type: "string",
          description:
            "Filtro LOCAL: buscar um CodChamado específico (ex: 0526-003997)",
        },
        inicio: {
          type: "number",
          description: "Paginação server-side: linha inicial (default 0)",
        },
        quantidade: {
          type: "number",
          description:
            "Paginação server-side: registros por página (default 500, max 2000)",
        },
        limite: {
          type: "number",
          description:
            "Truncar quantidade retornada ao cliente para evitar limite de 1MB (default 200)",
        },
      },
    },
  },
  {
    name: "buscar_chamado",
    description: "Busca um chamado pelo ID",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "ID do chamado" } },
      required: ["id"],
    },
  },

  // ===== Operadores / Históricos =====
  {
    name: "listar_operadores",
    description:
      "Lista operadores cadastrados. Útil para resolver nome → Chave do operador (necessária para lançar avaliação).",
    inputSchema: {
      type: "object",
      properties: {
        pesquisa: {
          type: "string",
          description: "Texto para filtrar (busca em nome/sobrenome/email)",
        },
        ativo: {
          type: "string",
          description: "S (ativos) ou N (inativos). Default: S",
        },
        grupo: {
          type: "string",
          description: "Código do grupo principal (filtro opcional)",
        },
        limite: { type: "number", description: "Trunca resultado (default 200)" },
      },
    },
  },
  {
    name: "listar_historicos",
    description:
      "Lista as interações/históricos de um chamado. Cada interação tem uma Chave que pode ser usada para lançar avaliação técnica.",
    inputSchema: {
      type: "object",
      properties: {
        chave: { type: "string", description: "Chave numérica do chamado" },
        cod_chamado: {
          type: "string",
          description: "CodChamado (ex: 0526-003997) — alternativa à chave",
        },
        solicitante: {
          type: "string",
          description:
            "S = oculta observações internas; N = exibe (default N)",
        },
      },
    },
  },

  // ===== Avaliação Técnica =====
  {
    name: "avaliar_chamado",
    description:
      "Lança avaliação técnica em alto nível. Recebe CodChamado + nome do operador e resolve internamente as chaves do chamado, operador e histórico. Usa a interação mais recente do operador no chamado.",
    inputSchema: {
      type: "object",
      properties: {
        cod_chamado: {
          type: "string",
          description: "CodChamado (ex: 0526-003997)",
        },
        nome_operador: {
          type: "string",
          description: "Nome (ou trecho) do operador a ser avaliado",
        },
        cod_avaliacao: { type: "string", description: "Nota da avaliação" },
        descricao: { type: "string", description: "Descrição da avaliação" },
        sugestao: { type: "string", description: "Sugestão (opcional)" },
      },
      required: ["cod_chamado", "nome_operador", "cod_avaliacao", "descricao"],
    },
  },
  {
    name: "lancar_avaliacao",
    description:
      "Lança uma avaliação técnica para um chamado (baixo nível — exige chaves já resolvidas).",
    inputSchema: {
      type: "object",
      properties: {
        chamado: {
          type: "string",
          description: "Chave numérica do chamado a ser avaliado",
        },
        operador: { type: "string", description: "ID do operador avaliado" },
        cod_avaliacao: {
          type: "string",
          description: "Código/nota da avaliação",
        },
        descricao: { type: "string", description: "Descrição da avaliação" },
        sugestao: { type: "string", description: "Sugestão (opcional)" },
        chave_historico: {
          type: "string",
          description: "Chave do histórico/interação avaliada",
        },
      },
      required: [
        "chamado",
        "operador",
        "cod_avaliacao",
        "descricao",
        "chave_historico",
      ],
    },
  },

  // ===== FAQ / Base de Conhecimento =====
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
 * EXECUÇÃO DAS TOOLS
 * =========================================================
 */
async function runTool(toolName, args = {}) {
  // ===== Chamados =====
  if (toolName === "criar_chamado") {
    if (!args.titulo || typeof args.titulo !== "string") {
      return toolText("Erro: o campo 'titulo' é obrigatório.", true);
    }
    if (!args.descricao || typeof args.descricao !== "string") {
      return toolText("Erro: o campo 'descricao' é obrigatório.", true);
    }

    const res = await deskAPI("POST", "/Chamados", {
      titulo: args.titulo,
      descricao: args.descricao,
      prioridade_id: args.prioridade_id ?? 4,
      CodSolicitante: COD_SOLICITANTE,
    });

    if (res.ok) {
      const dados = res.json || {};
      const numero =
        dados.id || dados.numero || dados.Ticket_ID || dados.codigo || "";
      return toolText(
        `Chamado criado com sucesso!${
          numero ? " Protocolo: " + numero : ""
        }\nResposta: ${res.text}`
      );
    }
    return toolText(`Erro HTTP ${res.status}:\n${res.text}`, true);
  }

  if (toolName === "listar_chamados") {
    const inicio = Number(args.inicio) || 0;
    const quantidade = Math.min(Number(args.quantidade) || 500, 2000);
    const limite = Number(args.limite) || 200;

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
      StartRow: inicio,
      EndRow: inicio + quantidade,
    };
    if (args.data_criacao) body.DataCriacao = args.data_criacao;

    const res = await deskAPI("POST", "/ChamadosSuporte/lista", body);
    if (!res.ok) {
      return toolText(`Erro HTTP ${res.status}:\n${res.text}`, true);
    }

    const data = res.json;
    if (data && Array.isArray(data.root)) {
      let filtrado = data.root;
      if (args.chave) {
        filtrado = filtrado.filter(
          (c) => String(c.Chave) === String(args.chave)
        );
      }
      if (args.cod_chamado) {
        filtrado = filtrado.filter((c) => c.CodChamado === args.cod_chamado);
      }
      const totalFiltrado = filtrado.length;
      const truncado = filtrado.slice(0, limite);
      const resposta = {
        root: truncado,
        total_api: data.total || data.root.length,
        total_filtrado: totalFiltrado,
        retornados: truncado.length,
        paginacao: { inicio, quantidade, fim: inicio + quantidade },
      };
      return toolText(`HTTP ${res.status}:\n${JSON.stringify(resposta)}`);
    }
    return toolText(`HTTP ${res.status}:\n${res.text}`);
  }

  if (toolName === "buscar_chamado") {
    if (!args.id || typeof args.id !== "string") {
      return toolText("Erro: o campo 'id' é obrigatório.", true);
    }
    const res = await deskAPI("GET", `/ChamadosSuporte/${args.id}`);
    if (res.ok) return toolText(`HTTP ${res.status}:\n${res.text}`);
    return toolText(`Erro HTTP ${res.status}:\n${res.text}`, true);
  }

  // ===== Operadores / Históricos =====
  if (toolName === "listar_operadores") {
    const limite = Number(args.limite) || 200;
    const body = {
      Colunas: {
        Chave: "on",
        Nome: "on",
        Sobrenome: "on",
        Email: "on",
        OnOff: "on",
        GrupoPrincipal: "on",
        EmailGrupo: "on",
        CodGrupo: "on",
      },
      Pesquisa: args.pesquisa || "",
      Ativo: args.ativo || "S",
      Filtro: {
        Ramal: [""],
        GrupoPrincipal: [args.grupo || ""],
        Perfil: [""],
        Online: [""],
        LicencaDMS: [""],
        LicencaCHAT: [""],
        LicencaRCS: [""],
        LicencaFornecedor: [""],
      },
      Ordem: [{ Coluna: "Nome", Direcao: "true" }],
    };

    const res = await deskAPI("POST", "/Operadores/lista", body);
    if (!res.ok) {
      return toolText(`Erro HTTP ${res.status}:\n${res.text}`, true);
    }

    const data = res.json;
    if (data && Array.isArray(data.root)) {
      const truncado = data.root.slice(0, limite);
      const resposta = {
        root: truncado,
        total_api: data.total || data.root.length,
        retornados: truncado.length,
      };
      return toolText(`HTTP ${res.status}:\n${JSON.stringify(resposta)}`);
    }
    return toolText(`HTTP ${res.status}:\n${res.text}`);
  }

  if (toolName === "listar_historicos") {
    const body = {
      Chave: args.chave || "",
      CodChamado: args.cod_chamado || "",
      Solicitante: args.solicitante || "N",
      Colunas: {
        Chave: "on",
        Descricao: "on",
        ObservacaoInterna: "on",
        Status: "on",
        Aberto: "on",
        DataCriacao: "on",
        HoraCriacao: "on",
        DataAcao: "on",
        Solicitante: "on",
        Operador: "on",
        NomeFormaAtendimento: "on",
        CodCausa: "on",
        NomeCausa: "on",
        HoraAcaoInicio: "on",
        HoraAcaoFim: "on",
        TotalHoras: "on",
      },
    };
    const res = await deskAPI("POST", "/ChamadoHistoricos/lista", body);
    if (res.ok) return toolText(`HTTP ${res.status}:\n${res.text}`);
    return toolText(`Erro HTTP ${res.status}:\n${res.text}`, true);
  }

  // ===== Avaliação Técnica =====
  if (toolName === "avaliar_chamado") {
    if (!args.cod_chamado || typeof args.cod_chamado !== "string") {
      return toolText("Erro: o campo 'cod_chamado' é obrigatório.", true);
    }
    if (!args.nome_operador || typeof args.nome_operador !== "string") {
      return toolText("Erro: o campo 'nome_operador' é obrigatório.", true);
    }
    if (args.cod_avaliacao === undefined || args.cod_avaliacao === null) {
      return toolText("Erro: o campo 'cod_avaliacao' é obrigatório.", true);
    }
    if (!args.descricao || typeof args.descricao !== "string") {
      return toolText("Erro: o campo 'descricao' é obrigatório.", true);
    }

    const texto = await orchestrateAvaliacao(args);
    // Marca como erro se a orquestração não chegou ao passo final.
    const isError =
      texto.startsWith("[1/4]") ||
      texto.startsWith("[2/4]") ||
      texto.startsWith("[3/4]");
    return toolText(texto, isError);
  }

  if (toolName === "lancar_avaliacao") {
    const obrigatorios = [
      "chamado",
      "operador",
      "cod_avaliacao",
      "descricao",
      "chave_historico",
    ];
    const faltando = obrigatorios.filter(
      (k) => args[k] === undefined || args[k] === null || args[k] === ""
    );
    if (faltando.length) {
      return toolText(
        `Erro: campos obrigatórios ausentes: ${faltando.join(", ")}.`,
        true
      );
    }

    const dados = {
      TAvaliacaoTecnica: {
        Chave: "",
        ChaveOperador: "",
        OperadorAvaliadoGrupo: "",
        QuemAvaliouGrupo: "",
        DataInteracao: "",
        HoraInteracao: "",
        DataAvaliacao: "",
        HoraAvaliacao: "",
        Operador: String(args.operador),
        Chamado: String(args.chamado),
        DescricaoDaAcao: "",
        NumeroAcao: "",
        CodAvaliacao: String(args.cod_avaliacao),
        Descricao: args.descricao || "",
        Sugestao: args.sugestao || "",
        LimparDS: "off",
      },
      THist: { Chave: String(args.chave_historico) },
    };
    const formData = {
      Dados: JSON.stringify(dados),
      Menu: "AvaliacaoTecnica",
      App: "EvaluationService",
    };
    const res = await deskWebForm("PUT", "/AvaliacaoTecnica", formData);
    if (res.ok) return toolText(`HTTP ${res.status}:\n${res.text}`);
    return toolText(`Erro HTTP ${res.status}:\n${res.text}`, true);
  }

  // ===== FAQ / Base =====
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
    service: SERVER_INFO.name,
    version: SERVER_INFO.version,
    transport: "streamable-http",
    tools: TOOLS.map((t) => t.name),
  });
});

/**
 * =========================================================
 * MCP ENDPOINT
 * =========================================================
 */
app.get("/mcp", authMiddleware, originMiddleware, (req, res) => {
  res.json({
    name: SERVER_INFO.name,
    version: SERVER_INFO.version,
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
          jsonRpcError(id, -32600, "Invalid Request", "jsonrpc deve ser '2.0'.")
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
          protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        })
      );
    }

    if (method === "notifications/initialized") {
      return res.status(204).send();
    }

    if (method === "tools/list") {
      return res.json(jsonRpcSuccess(id, { tools: TOOLS }));
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

      try {
        const result = await runTool(toolName, toolArgs);
        return res.json(jsonRpcSuccess(id, result));
      } catch (toolErr) {
        // Erros de execução de tool voltam como result.isError (padrão MCP),
        // não como erro de protocolo, para o modelo conseguir reagir.
        console.error("[MCP][TOOL ERROR]", toolName, toolErr);
        return res.json(
          jsonRpcSuccess(id, toolText(`Erro ao executar '${toolName}': ${toolErr.message}`, true))
        );
      }
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
  log(`Tools: ${TOOLS.map((t) => t.name).join(", ")}`);
});