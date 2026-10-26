import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFsTools } from "../tools/fsTools.js";
import { registerWebTools } from "../tools/webTools.js";
import { registerShellTools } from "../tools/shellTools.js";
import { registerSystemTools } from "../tools/systemTools.js";
import { installWorkspaceContext } from "./workspaceContext.js";

export function createMcpServer(workspaceRoot: string): McpServer {
  const server = new McpServer({
    name: "mcp-dev-toolkit",
    version: "1.0.0",
  });

  const getWorkspaceRoot = installWorkspaceContext(server, workspaceRoot);

  registerFsTools(server, getWorkspaceRoot);
  registerWebTools(server);
  registerShellTools(server, getWorkspaceRoot);
  registerSystemTools(server);

  return server;
}
