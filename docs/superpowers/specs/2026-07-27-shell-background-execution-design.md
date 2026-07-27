# Execução de comandos em background no servidor MCP

Data: 2026-07-27

## Problema

A tool `execute_command` (`src/tools/shellTools.ts`) é totalmente síncrona: usa
`promisify(exec)` e só retorna quando o processo termina. Comandos de longa
duração que nunca terminam sozinhos — `npm run dev`, `node server.js`, watchers —
travam a chamada até o timeout (máx. 120s) matar o processo.

Consequência prática: o agente não consegue subir uma API e testá-la. Ou ele
espera o timeout (e o servidor morre junto), ou não sobe o servidor.

## Objetivo

Permitir que o agente inicie um processo em background, receba um identificador
de volta, execute seus testes, e depois finalize o processo explicitamente.

## Decisões de design

### Registro singleton, não por sessão

`createMcpServer` é chamado **por sessão HTTP** (`src/server/express.ts:67`).
Se o registro de processos ficasse no escopo do servidor, uma nova sessão
perderia acesso aos processos iniciados pela anterior — e eles virariam órfãos
sem forma de serem mortos.

O registro é portanto um `Map` no nível do módulo `backgroundProcesses.ts`,
compartilhado por todas as sessões do processo Node.

### Identificador: ID lógico + PID

Cada processo recebe um ID curto e sequencial (`bg-1`, `bg-2`, ...) que é o
handle usado por todas as tools. O PID real do SO é retornado junto, para
conferência manual (Gerenciador de Tarefas, `taskkill`).

Motivo de não usar o PID como handle: o ID continua válido depois que o processo
morre, permitindo ler o log final e o exit code. PIDs também são reciclados pelo
SO.

### Captura de saída: buffer em memória

Cada processo mantém um buffer rotativo das últimas 1000 linhas de stdout +
stderr combinados, em ordem cronológica. Ao estourar o limite, as linhas mais
antigas são descartadas e a flag `truncated` é marcada.

Escolhido em vez de arquivo em disco por não exigir limpeza de arquivos
temporários. Custo aceito: o log se perde se o servidor MCP reiniciar — mas
nesse caso o processo também é morto pelo hook de shutdown.

### Warm-up de 2 segundos

Ao iniciar em background, a tool aguarda ~2s antes de retornar e inclui a saída
capturada nesse intervalo. Isso faz o agente ver imediatamente
`Server listening on :3000` ou `EADDRINUSE` sem precisar de uma segunda chamada.

Se o processo já tiver morrido durante o warm-up, o retorno reporta o status
`exited` e o exit code em destaque — o agente sabe na hora que o comando falhou.

### Encerramento: árvore de processos, não processo único

Os processos são criados com `shell: true`. No Windows isso significa que o PID
retornado é o do `cmd.exe`, e o `node` real é um processo **filho** dele. Um
`process.kill(pid)` simples mataria apenas o shell e deixaria a API órfã
segurando a porta.

- **win32:** `taskkill /PID <pid> /T /F` — o `/T` mata a árvore inteira.
- **POSIX:** spawn com `detached: true`, e `process.kill(-pid, "SIGTERM")` para
  atingir o grupo de processos; escalada para `SIGKILL` após 3s de carência.

## Alterações

### 1. Novo módulo `src/tools/backgroundProcesses.ts`

Contém o registro e toda a lógica de ciclo de vida. Não conhece o MCP — expõe
funções puras que `shellTools.ts` consome.

```ts
interface BackgroundProcess {
  id: string;                                  // "bg-1"
  pid: number;
  command: string;
  cwd: string;
  startedAt: Date;
  exitedAt: Date | null;
  status: "running" | "exited" | "killed";
  exitCode: number | null;
  output: string[];                            // buffer rotativo, máx. 1000 linhas
  truncated: boolean;
  child: ChildProcess;
}
```

API exportada:

| Função | Responsabilidade |
|---|---|
| `startBackgroundProcess(command, cwd)` | Faz spawn, registra, aguarda o warm-up, resolve com o snapshot inicial |
| `listBackgroundProcesses()` | Snapshot de todos os processos registrados (sem o buffer completo) |
| `readBackgroundOutput(id, lines)` | Últimas N linhas do buffer, ou `null` se o ID não existir |
| `stopBackgroundProcess(id)` | Mata a árvore, marca `killed`, devolve as últimas linhas |
| `killAllBackgroundProcesses()` | Encerramento síncrono, usado pelo hook de shutdown |

Detalhes de implementação:

- **Montagem de linhas:** chunks de stdout/stderr chegam fragmentados. Cada
  stream mantém um resto parcial; só linhas completas (terminadas em `\n`) vão
  para o buffer, e o resto pendente é anexado ao próximo chunk. No `exit`, o
  resto pendente é liberado como linha final.
- **Detecção de saída:** `child.on("exit")` grava `exitCode`, `exitedAt` e define
  o status como `exited` (ou mantém `killed` se o encerramento foi iniciado por
  nós).
- **Poda do registro:** processos já encerrados são mantidos para consulta do log
  final. Ao passar de 20 encerrados, os mais antigos são removidos.
- **Hook de shutdown:** registrado uma única vez na carga do módulo, em `exit`,
  `SIGINT` e `SIGTERM`. Usa `spawnSync`/`process.kill` (o handler de `exit` não
  permite trabalho assíncrono).

### 2. `execute_command` ganha o parâmetro `background`

```ts
background: z.boolean().optional().default(false)
```

Descrição para o LLM, explícita quanto ao caso de uso:

> Execute o comando em background e retorne imediatamente com um ID e um PID, em
> vez de aguardar o término. Use `true` para processos de longa duração que não
> terminam sozinhos — servidores de desenvolvimento (`npm run dev`,
> `node server.js`), watchers, qualquer coisa que ficaria travada até o timeout.
> Depois de iniciar, use `read-background-output` para acompanhar a saída e
> `stop-background-process` para encerrar quando os testes acabarem. Com `true`,
> o parâmetro `timeout` é ignorado.

Comportamento com `background: true`:

- A verificação de comandos perigosos (`isDangerousCommand`) continua valendo
  antes do spawn, exatamente como no modo síncrono.
- O `timeout` é ignorado; o processo vive até ser encerrado explicitamente ou até
  o servidor MCP cair.
- A resolução do diretório de trabalho é a mesma do modo síncrono.

Formato do retorno:

```
Processo iniciado em background
ID: bg-1
PID: 12345
Comando: npm run dev
Diretório: D:\projetos\minha-api
Status: running

--- Saída (primeiros 2s) ---
Server listening on :3000

Use read-background-output({ id: "bg-1" }) para ler mais.
Use stop-background-process({ id: "bg-1" }) para encerrar.
```

O caminho síncrono (`background: false`) permanece inalterado.

### 3. Três tools novas, em kebab-case

Nomes seguem o guia do projeto (`.claude/skills/mcp-tool-addition-guide`).
`execute_command` mantém o nome atual, em snake_case, para não quebrar prompts
existentes.

| Tool | Parâmetros | Retorno |
|---|---|---|
| `list-background-processes` | — | Tabela com id, pid, status, comando, cwd, uptime, exitCode |
| `read-background-output` | `id` (string), `lines` (number, default 100) | Últimas N linhas, com aviso se o buffer foi truncado |
| `stop-background-process` | `id` (string) | Confirmação do encerramento + últimas 20 linhas |

Casos de erro: ID inexistente retorna `isError: true` com a lista de IDs válidos.
Encerrar um processo já morto retorna sucesso, informando que ele já havia
terminado.

### 4. Renomeação do servidor

O nome atual, `web-scraper`, descreve mal um servidor que hoje expõe ferramentas
de arquivo, shell, web e sistema.

- `src/server/mcpServer.ts`: `name: "web-scraper"` → `name: "mcp-dev-toolkit"`
- `package.json`: `"name": "mcp-web-scraper"` → `"mcp-dev-toolkit"`
- `package.json`: a chave `bin` aponta para `./build/index.js`, caminho que não
  existe — o build gera em `dist/`. Corrigido para
  `"mcp-dev-toolkit": "./dist/index.js"`.

## Verificação

O projeto não tem framework de testes, e adicionar um está fora do escopo desta
mudança. A verificação é manual, via `npx tsc --noEmit` mais os seguintes
cenários executados através das tools:

1. **Servidor sobe:** `execute_command("npm run dev", background: true)` retorna
   ID e PID em ~2s, com a saída de inicialização visível.
2. **Retorno imediato:** a chamada não bloqueia pelos 30s de timeout padrão.
3. **Saída acumula:** `read-background-output` após algumas requisições HTTP
   mostra linhas de log que não estavam no warm-up.
4. **Árvore morre:** `stop-background-process` libera a porta — confirmado por
   um novo `execute_command("npm run dev", background: true)` que sobe sem
   `EADDRINUSE`.
5. **Crash é reportado:** subir dois servidores na mesma porta faz o segundo
   retornar status `exited` com o erro na saída do warm-up.
6. **Sessão cruzada:** `list-background-processes` de uma nova sessão MCP
   enxerga processos iniciados pela sessão anterior.
7. **Sem órfãos:** matar o servidor MCP com Ctrl+C libera a porta do processo
   filho.

## Fora de escopo

- Persistência do registro entre reinícios do servidor MCP.
- Streaming de saída em tempo real (o agente faz polling via
  `read-background-output`).
- Limites de recursos (CPU/memória) por processo.
- Reinício automático de processos que morreram.
