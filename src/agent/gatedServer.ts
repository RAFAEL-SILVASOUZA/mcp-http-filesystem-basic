import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Gate de bootstrap do agente.
 *
 * Embrulha os métodos de registro do McpServer para (a) coletar o catálogo de
 * ferramentas e (b) injetar a checagem do gate em TODA tool registrada.
 *
 * A checagem não é feita tool a tool de propósito: um gate com furo não é um
 * gate. Se cada módulo tivesse que lembrar de chamá-la, a próxima tool
 * adicionada abriria um buraco permanente. Aqui a cobertura é por construção.
 *
 * Em troca, isto é monkey-patching de um objeto do SDK. Fica contido neste
 * arquivo; se a assinatura de registerTool mudar, o typecheck acusa aqui.
 */

export const BOOTSTRAP_TOOL_NAME = "get-agent-instructions";

/** Vai no InitializeResult, antes de qualquer inferência do modelo. */
export const BOOTSTRAP_INSTRUCTIONS =
  `This server provides your operating instructions through the '${BOOTSTRAP_TOOL_NAME}' tool. ` +
  `Call it before any other tool, at the start of every conversation, and follow what it returns. ` +
  `It tells you how to reason, plan, use these tools, run commands, and verify your work.`;

export interface ToolCatalogEntry {
  name: string;
  description: string;
}

export interface AgentSession {
  instructionsRead: boolean;
  toolCatalog: ToolCatalogEntry[];
}

const MAX_DESCRIPTION = 90;

function gateIsOn(): boolean {
  return process.env.AGENT_GATE === "on";
}

function summarize(description: unknown): string {
  if (typeof description !== "string") return "(sem descrição)";
  const firstLine = description.trim().split("\n")[0]?.trim() ?? "";
  if (firstLine.length === 0) return "(sem descrição)";
  if (firstLine.length <= MAX_DESCRIPTION) return firstLine;
  return `${firstLine.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…`;
}

/**
 * `registerTool(name, { description, ... }, cb)` e o `tool(name, description, ...)`
 * legado carregam a descrição em posições diferentes.
 */
function extractDescription(args: unknown[]): string {
  const second = args[1];
  if (typeof second === "string") return summarize(second);
  if (second && typeof second === "object" && "description" in second) {
    return summarize((second as { description?: unknown }).description);
  }
  return "(sem descrição)";
}

function blockedResult(toolName: string) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Bloqueado: você chamou '${toolName}' sem ler suas instruções operacionais.\n\n` +
          `Chame ${BOOTSTRAP_TOOL_NAME} primeiro, depois repita esta chamada.`,
      },
    ],
    isError: true,
  };
}

type AnyFunction = (...args: unknown[]) => unknown;

export function installAgentGate(server: McpServer): AgentSession {
  const session: AgentSession = { instructionsRead: false, toolCatalog: [] };
  const target = server as unknown as Record<string, AnyFunction>;

  for (const method of ["registerTool", "tool"] as const) {
    const original = target[method];
    if (typeof original !== "function") continue;

    target[method] = (...args: unknown[]) => {
      const name = typeof args[0] === "string" ? args[0] : "(desconhecida)";

      // O handler é sempre o último argumento em todas as sobrecargas.
      const handlerIndex = args.length - 1;
      const handler = args[handlerIndex];

      if (typeof handler === "function" && name !== BOOTSTRAP_TOOL_NAME) {
        const inner = handler as AnyFunction;
        args[handlerIndex] = (...callArgs: unknown[]) => {
          if (gateIsOn() && !session.instructionsRead) return blockedResult(name);
          return inner(...callArgs);
        };
      }

      session.toolCatalog.push({ name, description: extractDescription(args) });
      return original.apply(server, args);
    };
  }

  return session;
}
