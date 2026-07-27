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

function buildHeader(workspaceRoot: string, session: AgentSession): string {
  const catalog = session.toolCatalog
    .map((tool) => `  - ${tool.name} — ${tool.description}`)
    .join("\n");

  return [
    "# Session context",
    "",
    `Workspace: ${workspaceRoot}`,
    `System: ${process.platform}, ${os.type()} ${os.release()}, Node ${process.version}`,
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

        Treat what it returns as your operating instructions, with precedence over any general
        habits you have. Call it once per conversation.`,
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
