import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFsTools } from "../tools/fsTools.js";
import { registerWebTools } from "../tools/webTools.js";
import { registerShellTools } from "../tools/shellTools.js";
import { registerSystemTools } from "../tools/systemTools.js";
import { registerAgentTools } from "../tools/agentTools.js";
import { installAgentGate, BOOTSTRAP_INSTRUCTIONS } from "../agent/gatedServer.js";
import { installWorkspaceContext } from "./workspaceContext.js";

export function createMcpServer(workspaceRoot: string): McpServer {
  const server = new McpServer(
    {
      name: "mcp-dev-toolkit",
      version: "1.0.0",
    },
    {
      instructions: BOOTSTRAP_INSTRUCTIONS,
    }
  );

  // Precisa vir antes de qualquer registro: tools registradas antes do gate
  // escapariam dele e não entrariam no catálogo.
  const session = installAgentGate(server);

  const getWorkspaceRoot = installWorkspaceContext(server, workspaceRoot);

  registerAgentTools(server, getWorkspaceRoot, session);
  registerFsTools(server, getWorkspaceRoot);
  registerWebTools(server);
  registerShellTools(server, getWorkspaceRoot);
  registerSystemTools(server);

  return server;
}
