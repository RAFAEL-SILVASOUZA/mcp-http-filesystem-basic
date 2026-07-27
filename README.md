# MCP Server

Um servidor **MCP (Model Context Protocol)** Streamable HTTP modular que fornece ferramentas para sistema de arquivos, navegação web e execução de comandos shell.

## 📋 Funcionalidades

### Tools Disponíveis

| Tool | Descrição |
|------|-----------|
| `file-glob` | Explora diretórios e lista arquivos/subdiretórios de forma hierárquica |
| `read-file` | Lê o conteúdo completo de arquivos de texto |
| `create-file` | Cria um novo arquivo com o conteúdo especificado (suporta sobrescrever) |
| `edit-file` | Edita um arquivo existente substituindo texto específico (suporta replaceAll) |
| `grep` | Busca padrões (texto/regex) em múltiplos arquivos com suporte a glob |
| `scrape_url` | Busca URLs e extrai texto visível de páginas HTML |
| `websearch` | Pesquisa na web usando DuckDuckGo e retorna resultados com títulos, URLs e snippets |
| `execute_command` | Executa comandos shell, de forma síncrona ou em background (`background: true`) |
| `list-background-processes` | Lista os processos iniciados em background, com ID, PID e status |
| `read-background-output` | Lê o stdout/stderr acumulado de um processo em background |
| `stop-background-process` | Encerra um processo em background (mata a árvore inteira) |
| `get-system-info` | Retorna data, hora e informações do sistema operacional |

### Executando servidores em background

Comandos que não terminam sozinhos — `npm run dev`, `node server.js`, watchers —
travariam a chamada até o timeout matá-los. Para esses casos, use `background: true`:

```jsonc
// 1. sobe a API e devolve o handle em ~2s, já com a saída de inicialização
{ "name": "execute_command",
  "arguments": { "command": "npm run dev", "background": true } }
// → ID: bg-1, PID: 12345, "Server listening on :3000"

// 2. testa a API livremente (scrape_url, execute_command com curl, etc.)

// 3. lê os logs gerados pelos testes
{ "name": "read-background-output", "arguments": { "id": "bg-1" } }

// 4. encerra ao terminar — libera a porta
{ "name": "stop-background-process", "arguments": { "id": "bg-1" } }
```

O registro de processos é compartilhado por todas as sessões MCP, e todos os
processos vivos são encerrados quando o servidor MCP é derrubado — não ficam órfãos
segurando portas.

---

## 🚀 Instalação

### Pré-requisitos
- Node.js 18+ 
- npm ou yarn

### Passos

```bash
# Clonar repositório (se aplicável)
git clone <your-repo-url>
cd mcp-http

# Instalar dependências
npm install

# Construir o projeto
npm run build
```

---

## 📝 Uso

### Modo de Desenvolvimento

```bash
npm run dev
```

### Produção

```bash
npm run build
npm start
```

### Variáveis de Ambiente

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `PORT` | `3001` | Porta do servidor HTTP |

---

## 🔧 Configuração MCP

### Para Claude Desktop

Adicione ao arquivo `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mcp-dev-toolkit": {
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

### Para Outros Clientes MCP

```json
{
  "type": "http",
  "url": "http://localhost:3001/mcp"
}
```

---

## 🛠️ Documentação das Tools

### `file-glob`

Explora um diretório e lista arquivos e subdiretórios.

**Parâmetros:**
```typescript
{
  path: string,           // Caminho do diretório
  maxDepth: number       // Profundidade máxima (1-10, default: 3)
}
```

**Exemplo de Uso:**
```json
{
  "name": "file-glob",
  "arguments": {
    "path": "/Users/rafaelss8/Projetos/Pessoal/mcp-http/src",
    "maxDepth": 3
  }
}
```

**Resposta:**
```json
{
  "path": "/Users/rafaelss8/Projetos/Pessoal/mcp-http/src",
  "maxDepth": 3,
  "directories": ["(no subdirectories)"],
  "files": ["index.ts"],
  "summary": "Found 0 directory(ies) and 1 file(s)"
}
```

---

### `read-file`

Lê o conteúdo de um arquivo.

**Parâmetros:**
```typescript
{
  path: string,          // Caminho do arquivo
  encoding: string       // Codificação (default: "utf-8")
}
```

**Exemplo de Uso:**
```json
{
  "name": "read-file",
  "arguments": {
    "path": "/Users/rafaelss8/Projetos/Pessoal/mcp-http/src/index.ts"
  }
}
```

---

### `create-file`

Cria um novo arquivo com o conteúdo especificado. Cria diretórios pais se não existirem. Não sobrescreve por padrão (use `overwrite: true` para forçar).

**Parâmetros:**
```typescript
{
  path: string,          // Caminho do arquivo
  content: string,       // Conteúdo do arquivo
  encoding: string       // Codificação (default: "utf-8")
}
```

**Exemplo de Uso:**
```json
{
  "name": "create-file",
  "arguments": {
    "path": "/Users/rafaelss8/Projetos/Pessoal/mcp-http/src/new-file.ts",
    "content": "console.log('Hello World');"
  }
}
```

**Resposta:**
```
File created successfully at: /Users/rafaelss8/Projetos/Pessoal/mcp-http/src/new-file.ts
```

---

### `edit-file`

Edita um arquivo existente substituindo texto específico. O `oldText` deve corresponder exatamente ao conteúdo do arquivo.

**Parâmetros:**
```typescript
{
  path: string,          // Caminho do arquivo
  oldText: string,       // Texto a ser substituído (use vazio para append)
  newText: string,       // Texto de substituição (use vazio para deletar)
  encoding: string       // Codificação (default: "utf-8")
}
```

**Exemplo de Uso:**
```json
{
  "name": "edit-file",
  "arguments": {
    "path": "/Users/rafaelss8/Projetos/Pessoal/mcp-http/src/index.ts",
    "oldText": "console.log('Hello')",
    "newText": "console.log('Hello World')"
  }
}
```

**Resposta:**
```
File edited successfully at: /Users/rafaelss8/Projetos/Pessoal/mcp-http/src/index.ts

Replaced text with: console.log('Hello World')
```

---

### `scrape_url`

Busca uma URL e retorna o texto visível da página.

**Parâmetros:**
```typescript
{
  url: string,           // URL a ser scrapada
  max_length: number     // Máximo de caracteres (100-500000, default: 10000)
}
```

**Exemplo de Uso:**
```json
{
  "name": "scrape_url",
  "arguments": {
    "url": "https://example.com",
    "max_length": 10000
  }
}
```

**Resposta:**
```
Page: Example Domain
URL: https://example.com

Example Domain

This domain is for use in illustrative examples in documents. You may use this
domain in examples without prior coordination or asking for permission.
```

---

## 🏗️ Arquitetura

```
mcp-http/
├── src/
│   ├── index.ts            # Ponto de entrada (bootstrap)
│   ├── server/
│   │   ├── express.ts      # Configuração do servidor Express + CORS
│   │   └── mcpServer.ts    # Fábrica do McpServer
│   ├── tools/
│   │   ├── fsTools.ts      # Tools de sistema de arquivos (file-glob, read-file, create-file, edit-file, grep)
│   │   ├── webTools.ts     # Tools web (scrape_url, websearch)
│   │   ├── shellTools.ts   # Tools de shell (execute_command + gestão de background)
│   │   ├── backgroundProcesses.ts # Registro e ciclo de vida dos processos em background
│   │   └── systemTools.ts  # Tools de sistema (get-system-info)
│   └── utils/
│       ├── fs.ts           # Utilitários de FS (gitignore, exploreDirectory)
│       └── path.ts         # Validação de caminhos (anti path-traversal)
├── dist/                   # Arquivos compilados (após build)
├── package.json            # Dependências e scripts
├── tsconfig.json           # Configuração TypeScript
└── README.md               # Este arquivo
```

### Fluxo do Servidor

```
┌─────────────┐
│   Client    │
│  (LLM/MCP)  │
└──────┬──────┘
       │ HTTP Request
       ▼
┌─────────────────┐
│    Express      │
│   Middleware    │
│     (CORS)      │
└──────┬──────────┘
       │
       ▼
┌─────────────────┐
│  StreamableHTTP │
│  ServerTransport│
└──────┬──────────┘
       │
       ▼
┌─────────────────┐
│    McpServer    │
│  (8 Tools)      │
│  • file-glob    │
│  • read-file    │
│  • create-file  │
│  • edit-file    │
│  • grep         │
│  • scrape_url   │
│  • websearch    │
│  • exec_command │
└─────────────────┘
```

### Melhorias Recentes

- **Arquitetura Modular**: Código organizado em módulos separados por responsabilidade
- **Validação de Segurança**: Proteção contra Path Traversal (`validatePathInWorkspace`)
- **Sessão Stateful**: Transportes MCP armazenados por sessão para conexões persistentes
- **create-file**: Suporte a sobrescrita via parâmetro `overwrite`
- **edit-file**: Suporte a substituição parcial via parâmetro `replaceAll`

---

## ⚙️ Scripts Disponíveis

| Comando | Descrição |
|---------|-----------|
| `npm run build` | Compila TypeScript para JavaScript |
| `npm run dev` | Inicia servidor em modo de desenvolvimento |
| `npm start` | Inicia servidor em produção |

---

## 🔒 Segurança

### Limitações de Segurança

| Tool | Restrições |
|------|------------|
| `file-glob` | Apenas leitura, profundidade máxima de 10 níveis |
| `read-file` | Apenas leitura de arquivos de texto |
| `create-file` | Não sobrescreve arquivos existentes por padrão (flag `wx`). Use `overwrite: true` para forçar |
| `edit-file` | Valida que `oldText` existe antes de editar |
| `grep` | Respeita `.gitignore`, limita resultados a 1000 matches |
| `scrape_url` | Timeout de 15s, User-Agent definido |
| `websearch` | Timeout de 10s, DuckDuckGo como motor de busca |
| `execute_command` | Padrões perigosos (`rm -rf`, `sudo`, `format`, `dd`…) exigem `confirmed: true`; timeout configurável no modo síncrono |
| `stop-background-process` | Encerra a árvore de processos (`taskkill /T /F` no Windows), garantindo que a porta seja liberada |

### Validação de Caminhos (Anti Path-Traversal)

Todas as ferramentas que operam no sistema de arquivos passam pela função `validatePathInWorkspace`, que garante que:
- Caminhos resolvidos permaneçam dentro do `workspaceRoot`
- Tentativas de escapar via `../` sejam bloqueadas
- Arquivos sensíveis fora do workspace não sejam acessíveis

---

## 📊 Dependências

### Produção
- `@modelcontextprotocol/sdk` - SDK MCP oficial
- `express` - Framework HTTP
- `cheerio` - Manipulação de HTML
- `zod` - Validação de schemas

### Desenvolvimento
- `tsx` - Execução de TypeScript
- `typescript` - Type checker
- `@types/*` - Definições de tipo

---

## 🐛 Debug

### Logs do Servidor

O servidor emite logs no stderr:
```
[mcp] POST /mcp sessionId=xxx
[mcp] Request handled. Session: xxx
```

### Testar Endpoint

```bash
curl -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

---

## 📄 Licença

MIT

---

## 🤝 Contribuição

1. Fork o projeto
2. Crie sua branch (`git checkout -b feature/AmazingFeature`)
3. Commit suas mudanças (`git commit -m 'Add some AmazingFeature'`)
4. Push para a branch (`git push origin feature/AmazingFeature`)
5. Abra um Pull Request

