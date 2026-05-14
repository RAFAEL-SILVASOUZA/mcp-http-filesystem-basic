import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFsTools } from "../tools/fsTools.js";
import { registerWebTools } from "../tools/webTools.js";
import { registerShellTools } from "../tools/shellTools.js";

export function createMcpServer(workspaceRoot: string): McpServer {
  const server = new McpServer({
    name: "web-scraper",
    version: "1.0.0",
  });

  registerFsTools(server, workspaceRoot);
  registerWebTools(server);
  registerShellTools(server, workspaceRoot);

  return server;
}
