import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as os from "os";

export function registerSystemTools(server: McpServer) {
  server.tool(
    "get-system-info",
    "Returns the current date, time, and operating system information.",
    {},
    async () => {
      const info = {
        datetime: new Date().toISOString(),
        os: {
          platform: os.platform(),
          arch: os.arch(),
          release: os.release(),
          type: os.type(),
          hostname: os.hostname(),
          uptime: os.uptime(),
        },
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(info, null, 2),
          },
        ],
      };
    }
  );
}
