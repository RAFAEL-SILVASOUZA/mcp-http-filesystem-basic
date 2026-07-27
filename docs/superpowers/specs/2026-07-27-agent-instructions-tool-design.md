# Tool de instruções operacionais para o agente

Data: 2026-07-27

## Problema

O alvo é um launcher de llama.cpp puro: um modelo com acesso às tools deste
servidor MCP e nenhum system prompt de agente. Sem instruções operacionais, o
modelo não tem disciplina de raciocínio, não planeja, não verifica o próprio
trabalho e usa as ferramentas de forma errática — sobrescreve arquivos, deixa
servidores rodando, declara sucesso sem evidência.

A ideia é o servidor MCP entregar essas instruções ele mesmo, através de uma
tool que o agente lê antes de qualquer outra coisa.

## O problema real não é o conteúdo, é a aderência

Uma tool que devolve texto é trivial. O difícil é garantir que ela seja chamada,
e que o texto devolvido tenha peso. Duas limitações honestas:

1. **Nada obriga o modelo a chamar uma tool.** Com llama.cpp cru não há
   scaffolding; se o modelo ignorar a tool, não existe agente.
2. **O retorno de uma tool não é um system prompt.** Ele entra na conversa como
   mensagem de tool, e modelos dão menos peso a isso do que ao system prompt.

O design ataca as duas com três camadas independentes, nenhuma delas suficiente
sozinha.

### Camada 1 — `instructions` no `McpServer`

Campo do protocolo MCP, entregue no `InitializeResult` antes de qualquer
inferência. Recebe um texto curto apontando para a tool. Clientes que respeitam o
protocolo injetam no system prompt automaticamente; llama.cpp cru provavelmente
ignora. Custo próximo de zero, então entra de qualquer forma.

### Camada 2 — bootstrap mínimo no launcher

Fora deste repositório, mas parte do design: três linhas no system prompt do
llama.cpp mandando chamar `get-agent-instructions` primeiro e tratar o retorno
como instruções operacionais de precedência superior.

É a camada que dá **autoridade** ao texto da camada 3 — sem ela, o retorno da
tool é só mais uma mensagem na conversa.

### Camada 3 — gate nas demais tools

O enforcement de verdade: se qualquer outra tool for chamada antes de
`get-agent-instructions`, ela recusa e diz o que fazer. Funciona mesmo que o
modelo ignore as camadas 1 e 2.

## Decisões de design

### Gate por wrapper, não por checagem espalhada

A verificação NÃO é adicionada tool por tool em `fsTools`, `webTools`,
`shellTools` e `systemTools`. Em vez disso, um módulo único embrulha os métodos
de registro do `McpServer` e injeta a checagem em toda tool registrada.

Motivo: um gate com furo não é um gate. Com checagem manual por módulo, a próxima
tool adicionada esquece dela e abre um buraco permanente. O wrapper garante
cobertura por construção.

Custo aceito: é monkey-patching de um objeto do SDK. Fica contido em um módulo
nomeado e documentado; se a assinatura de `registerTool` mudar, o typecheck
acusa na hora.

Efeito colateral aproveitado: como todo registro passa pelo wrapper, o **catálogo
de ferramentas é coletado de graça** — sem lista mantida à mão, que envelheceria.

### Gate desligado por padrão

Ativado por `AGENT_GATE=on`. Desligado, a tool continua funcionando normalmente;
apenas o bloqueio das demais não acontece.

Motivo: ligado por padrão, o gate afetaria todo cliente que usa este servidor,
inclusive os que já têm um bom system prompt e não precisam dele. Ele é ligado
explicitamente no launcher do llama.cpp, que é onde faz falta.

### Texto em arquivo, lido a cada chamada

O corpo das instruções vive em `prompts/agent-instructions.md`, fora do
TypeScript. O arquivo é lido a cada chamada, não cacheado em memória.

Motivo: esse texto vai ser iterado muito. Ler a cada chamada faz um ajuste de
redação valer na próxima conversa, sem rebuild e sem reiniciar o servidor. O
custo é uma leitura de arquivo pequeno por sessão.

### Perfil único

Sem parâmetro `profile`. Programação e pesquisa usam as mesmas ferramentas e a
mesma disciplina; perfis separados duplicariam a maior parte do texto e exigiriam
que o modelo escolhesse certo na primeira chamada — antes de saber o que vai
fazer.

## Alterações

### 1. `prompts/agent-instructions.md` (novo)

Corpo das instruções, em markdown. Seções:

- **Identidade e objetivo** — o que o agente é e o que se espera dele.
- **Ciclo de trabalho** — entender → planejar → executar → verificar. Agir quando
  há informação suficiente; perguntar só quando leituras diferentes levariam a
  trabalhos materialmente diferentes.
- **Uso de ferramentas** — ler antes de editar; `edit-file` em arquivo existente
  e `create-file` apenas para arquivo novo; nunca recriar um arquivo deletando e
  recriando. Reflete `.claude/rules/behavior.md`.
- **Disciplina de shell** — confirmação antes de executar; `background: true`
  para servidores e watchers; sempre encerrar com `stop-background-process` o que
  foi iniciado.
- **Verificação antes de concluir** — evidência antes de afirmação. Rodar o
  comando e ler a saída antes de dizer que passou.
- **Honestidade sobre falhas** — reportar teste que falhou com a saída real;
  dizer explicitamente o que foi pulado.
- **Anti-padrões** — declarar sucesso sem verificar; alargar ou estreitar o
  escopo pedido em silêncio; deixar processos rodando.

### 2. `src/agent/gatedServer.ts` (novo)

```ts
export const BOOTSTRAP_TOOL_NAME = "get-agent-instructions";

export interface ToolCatalogEntry {
  name: string;
  description: string;   // primeira linha, truncada em ~80 chars
}

export interface AgentSession {
  instructionsRead: boolean;
  toolCatalog: ToolCatalogEntry[];
}

export function installAgentGate(server: McpServer): AgentSession;
```

`installAgentGate` substitui `server.registerTool` e `server.tool` por versões
que, para cada tool registrada:

1. Registram nome e descrição em `session.toolCatalog`. As duas assinaturas
   precisam ser tratadas: `registerTool(name, { description, inputSchema }, fn)` e
   `tool(name, description, schema, fn)` — ambas em uso no projeto hoje.
2. Embrulham o handler com a checagem do gate, exceto para
   `BOOTSTRAP_TOOL_NAME`.

O gate só bloqueia quando `process.env.AGENT_GATE === "on"`. A mensagem de
bloqueio é auto-corretiva:

```
Bloqueado: você chamou 'execute_command' sem ler suas instruções operacionais.
Chame get-agent-instructions primeiro, depois repita esta chamada.
```

Estado por sessão, já que `createMcpServer` é chamado por sessão HTTP — uma
sessão nova sempre relê as instruções.

### 3. `src/tools/agentTools.ts` (novo)

Registra `get-agent-instructions`, sem parâmetros. Descrição escrita para ser
impossível de ignorar, já que é a única coisa que o modelo lê antes de decidir
chamá-la:

> **CALL THIS FIRST, BEFORE ANY OTHER TOOL, AT THE START OF EVERY CONVERSATION.**
> Returns your operating instructions: how to reason, plan, use tools, run
> commands, and verify your work. Other tools in this server may refuse to run
> until you have called this.

O handler monta o retorno em duas partes.

**Cabeçalho dinâmico**, gerado a cada chamada:

```
Workspace: D:\projetos\minha-api
Sistema: win32, Windows 11 (10.0.26200), Node v22.19.0
Data/hora: 2026-07-27T14:32:00.000Z
Ferramentas disponíveis (13):
  - file-glob — Explora diretórios e lista arquivos
  - execute_command — Execute ANY shell command...
  ...
```

Sem isso o agente gasta várias chamadas descobrindo onde está e o que tem.

**Corpo**, lido de `prompts/agent-instructions.md`.

Resolução do caminho: `new URL("../../prompts/agent-instructions.md", import.meta.url)`.
A profundidade é a mesma em `src/tools/` (via tsx) e em `dist/tools/` (após
build), então o mesmo caminho relativo serve nos dois modos. Sobrescrevível por
`AGENT_INSTRUCTIONS_PATH`.

Se o arquivo não existir, retorna `isError: true` informando o caminho resolvido
— falha explícita, não instruções silenciosamente vazias.

Ao final, marca `session.instructionsRead = true`.

### 4. `src/server/mcpServer.ts` (alteração)

O gate precisa ser instalado **antes** de qualquer registro de tool, senão as
tools registradas antes escapam dele:

```ts
const server = new McpServer(
  { name: "mcp-dev-toolkit", version: "1.0.0" },
  { instructions: BOOTSTRAP_INSTRUCTIONS }
);

const session = installAgentGate(server);

registerAgentTools(server, workspaceRoot, session);
registerFsTools(server, workspaceRoot);
registerWebTools(server);
registerShellTools(server, workspaceRoot);
registerSystemTools(server);
```

### 5. `README.md` (alteração)

Documentar a tool, a variável `AGENT_GATE`, a variável
`AGENT_INSTRUCTIONS_PATH`, e o trecho de bootstrap sugerido para o system prompt
do llama.cpp.

## Verificação

Sem framework de testes no projeto; a verificação é `npx tsc --noEmit` mais um
script funcional, no mesmo formato usado na feature de background:

1. **Gate desligado (padrão):** `execute_command` funciona sem que
   `get-agent-instructions` tenha sido chamada.
2. **Gate ligado:** com `AGENT_GATE=on`, `execute_command` é bloqueada e a
   mensagem cita o nome da tool chamada e o que fazer.
3. **Desbloqueio:** após `get-agent-instructions`, a mesma chamada passa.
4. **Isenção:** `get-agent-instructions` nunca é bloqueada por ela mesma.
5. **Catálogo:** o cabeçalho lista todas as tools registradas, incluindo as de
   background, com descrição não vazia.
6. **Contexto dinâmico:** o cabeçalho traz o `workspaceRoot` correto da sessão.
7. **Edição a quente:** alterar `prompts/agent-instructions.md` muda o retorno da
   chamada seguinte, sem reiniciar.
8. **Arquivo ausente:** retorna `isError` com o caminho resolvido.
9. **Isolamento de sessão:** uma segunda sessão MCP começa com
   `instructionsRead: false`.

## Fora de escopo

- Perfis separados de instruções (coding / research).
- Reinjeção periódica das instruções em conversas longas.
- Ajuste do texto por modelo (um texto serve para todos).
- O launcher do llama.cpp em si — apenas o trecho de bootstrap é documentado.
