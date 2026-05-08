---
name: "mcp-tool-addition-guide"
description: "Guia técnico para a implementação de novas tools no servidor MCP, com foco rigoroso no padrão de nomenclatura kebab-case (xxx-xxx-xxx)."
---

# Adicionando Tools ao Servidor MCP

Para adicionar novas funcionalidades ao servidor, siga este guia para garantir a compatibilidade e a padronização do projeto.

## ⚠️ Regra de Ouro: Nomenclatura
**OBRIGATÓRIO:** O nome da tool deve seguir rigorosamente o padrão **kebab-case** (`xxx-xxx-xxx`).

- ✅ **Correto:** `web-scrape-content`, `get-user-data`, `calculate-sum`
- ❌ **Incorreto:** `webScrapeContent` (camelCase), `web_scrape_content` (snake_case), `WebScrape` (PascalCase)

## 🛠️ Passo a Passo de Implementação

### 1. Definição da Tool
As tools são definidas no array `tools` ao instanciar o `McpServer`. Cada tool deve ter:
- `description`: Uma descrição clara para que o LLM saiba quando usá-la.
- `parameters`: Um objeto definindo os argumentos necessários.
- `execute`: A função assíncrona que contém a lógica de execução.

### 2. Exemplo de Implementação
```typescript
const server = new McpServer({
  name: "meu-servidor",
  version: "1.0.0",
  tools: {
    "minha-nova-tool": { // <--- Padrão xxx-xxx-xxx
      description: "Faz algo incrível com os dados",
      parameters: {
        input: { type: "string", description: "O texto de entrada" },
      },
      execute: async ({ input }) => {
        // Lógica de negócio aqui
        return { 
          content: [{ type: "text", text: `Resultado para: ${input}` }] 
        };
      },
    },
  },
});
```

## 🔍 Verificação
Após adicionar a tool, reinicie o servidor e utilize um cliente MCP para listar as tools disponíveis e validar se o nome foi registrado corretamente.