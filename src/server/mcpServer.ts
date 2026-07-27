import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFsTools } from "../tools/fsTools.js";
import { registerWebTools } from "../tools/webTools.js";
import { registerShellTools } from "../tools/shellTools.js";
import { registerSystemTools } from "../tools/systemTools.js";
import { registerAgentTools } from "../tools/agentTools.js";
import { installAgentGate, BOOTSTRAP_INSTRUCTIONS } from "../agent/gatedServer.js";

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

  registerAgentTools(server, workspaceRoot, session);
  registerFsTools(server, workspaceRoot);
  registerWebTools(server);
  registerShellTools(server, workspaceRoot);
  registerSystemTools(server);

  return server;
}
