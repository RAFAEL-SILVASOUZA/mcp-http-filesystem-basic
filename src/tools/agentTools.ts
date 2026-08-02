import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import * as os from "os";
import { BOOTSTRAP_TOOL_NAME, type AgentSession } from "../agent/gatedServer.js";

/**
 * O arquivo de instruções fica na raiz do repositório, em prompts/. A
 * profundidade relativa é a mesma a partir de src/tools/ (via tsx) e de
 * dist/tools/ (após o build), então o mesmo caminho serve nos dois modos.
 */
function resolveInstructionsPath(): string {
  const override = process.env.AGENT_INSTRUCTIONS_PATH;
  if (override && override.trim()) return override.trim();
  return fileURLToPath(new URL("../../prompts/agent-instructions.md", import.meta.url));
}

/**
 * O shell não é escolhido pelo servidor: `exec`/`spawn({ shell: true })` usam
 * %ComSpec% no Windows e /bin/sh no resto. O agente precisa saber qual é antes
 * de escrever o primeiro comando — errar aqui custa um round-trip garantido.
 */
function describeShell(): string {
  if (process.platform === "win32") {
    return `${process.env.ComSpec ?? "cmd.exe"} (cmd.exe — NOT PowerShell, NOT bash)`;
  }
  return "/bin/sh (POSIX)";
}

function buildHeader(workspaceRoot: string, session: AgentSession): string {
  const catalog = session.toolCatalog
    .map((tool) => `  - ${tool.name} — ${tool.description}`)
    .join("\n");

  return [
    "# Session context",
    "",
    `Workspace: ${workspaceRoot}`,
    `System: ${process.platform}, ${os.type()} ${os.release()}, Node ${process.version}`,
    `Shell used by execute_command: ${describeShell()}`,
    `Date/time: ${new Date().toISOString()}`,
    "",
    `Available tools (${session.toolCatalog.length}):`,
    catalog || "  (nenhuma registrada)",
  ].join("\n");
}

export function registerAgentTools(
  server: McpServer,
  workspaceRoot: string,
  session: AgentSession
) {
  server.registerTool(
    BOOTSTRAP_TOOL_NAME,
    {
      description:
        `CALL THIS FIRST, BEFORE ANY OTHER TOOL, AT THE START OF EVERY CONVERSATION.

        Returns your operating instructions: how to reason, plan, use the tools in this server,
        run shell commands, and verify your work before claiming something is done. It also
        returns the current session context — workspace path, operating system, date, and the
        full list of tools available to you.

        Other tools in this server may refuse to run until you have called this.

        Call it once per conversation. What it returns is workspace-specific and is not in your
        context already — the session header alone (real workspace path, OS, shell, tool list)
        cannot be inferred. Where it overlaps with operating instructions your host client
        already gave you, it wins: follow it, and where the two differ in strictness, follow
        the stricter one.`,
      inputSchema: {},
    },
    async () => {
      const path = resolveInstructionsPath();

      let body: string;
      try {
        body = await readFile(path, "utf-8");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Não foi possível ler o arquivo de instruções do agente.\n\n` +
                `Caminho resolvido: ${path}\n` +
                `Erro: ${message}\n\n` +
                `Crie o arquivo, ou aponte AGENT_INSTRUCTIONS_PATH para outro local.`,
            },
          ],
          isError: true,
        };
      }

      session.instructionsRead = true;

      return {
        content: [
          {
            type: "text" as const,
            text: `${buildHeader(workspaceRoot, session)}\n\n---\n\n${body.trim()}`,
          },
        ],
      };
    }
  );
}
