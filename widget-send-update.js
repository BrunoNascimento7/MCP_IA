// =====================================================================
// MUDANÇA NO WIDGET (função send() no JS)
// =====================================================================
// Antes o widget chamava api.anthropic.com direto, o que NÃO funciona
// em produção (a API key ficaria exposta no HTML).
//
// Agora ele chama a rota /chat do SEU serviço, que cuida do resto:
//   1. Guarda a API key em variável de ambiente (x-api-key)
//   2. Configura o MCP server (apontando para o /mcp do MESMO serviço)
//   3. Configura o system prompt da SIA
//
// IMPORTANTE: /chat e /mcp são o MESMO serviço no Render.
// Então PROXY_URL é a URL pública do seu serviço + "/chat".
// O widget fica simples — só envia o histórico de mensagens.
// =====================================================================

// Troque pelo endereço público do SEU serviço no Render (o mesmo do /mcp).
const PROXY_URL = "https://mcp-ia.onrender.com/chat";

async function send() {
  const text = input.value.trim();
  if (!text) return;

  addMessage(text, "user");
  history.push({ role: "user", content: text });

  input.value = "";
  input.style.height = "auto";
  sendBtn.disabled = true;
  showTyping();

  try {
    // Chama a rota /chat do seu serviço (não a Anthropic direto)
    const response = await fetch(PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history }),
    });

    const data = await response.json();
    hideTyping();

    // A rota /chat devolve { error, detail } em caso de falha
    if (!response.ok || data.error) {
      console.error("Erro do /chat:", data.error, data.detail || "");
      addMessage(
        "Desculpe, não consegui processar agora. Tente novamente.",
        "bot"
      );
      sendBtn.disabled = false;
      return;
    }

    if (!Array.isArray(data.content)) {
      addMessage(
        "Desculpe, não consegui processar agora. Tente novamente.",
        "bot"
      );
      sendBtn.disabled = false;
      return;
    }

    // Mostra as ferramentas MCP que foram chamadas
    data.content
      .filter((b) => b.type === "mcp_tool_use")
      .forEach((b) => addToolUse(b.name));

    // Concatena a resposta final de texto
    const replyText = data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (replyText) {
      addMessage(replyText, "bot");
      history.push({ role: "assistant", content: replyText });
    } else {
      addMessage("Pronto! Algo mais que eu possa ajudar?", "bot");
    }
  } catch (err) {
    hideTyping();
    addMessage("Ops, tive um problema na conexão. Tente novamente.", "bot");
    console.error(err);
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}