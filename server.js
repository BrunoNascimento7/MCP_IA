import express from "express";
import {
  Server
} from "@modelcontextprotocol/sdk/server/index.js";

import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";


const server = new Server(
  {
    name: "dm-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ping",
      description: "Testa conexão",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;

  if (name === "ping") {
    return {
      content: [
        {
          type: "text",
          text: "pong",
        },
      ],
    };
  }

  throw new Error("Tool não encontrada");
});


const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  try {
    const response = await server.handleRequest(req.body);
    res.json(response);
  } catch (err) {
    console.error(err);
    res.status(500).send("Erro no MCP");
  }
});

app.get("/", (req, res) => {
  res.send("MCP Server rodando");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Servidor rodando na porta", PORT);
});