import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const workspaceContext = new AsyncLocalStorage<string>();
const workspaceArgument = z.string().refine(
  (value) => isAbsolute(value),
  "x-workspace-root must be an absolute path on the server"
).optional().describe(
  "Absolute workspace directory on the server for this call only. Overrides the X-Workspace-Root HTTP header. Omit to use the session workspace or server working directory."
);

type AnyFunction = (...args: any[]) => any;

/** Install before registering tools, including legacy tool() registrations. */
export function installWorkspaceContext(server: McpServer, defaultRoot: string): () => string {
  const target = server as unknown as Record<string, AnyFunction>;
  for (const method of ["registerTool", "tool"] as const) {
    const original = target[method];
    target[method] = (...args: any[]) => {
      if (method === "registerTool") {
        args[1] = { ...args[1], inputSchema: {
          ...args[1].inputSchema,
          "x-workspace-root": workspaceArgument,
        } };
      } else {
        // Legacy overloads: tool(name, [description], [schema], callback).
        const schemaIndex = typeof args[1] === "string" ? 2 : 1;
        if (typeof args[schemaIndex] === "function") args.splice(schemaIndex, 0, {});
        args[schemaIndex] = { ...args[schemaIndex], "x-workspace-root": workspaceArgument };
      }
      const handlerIndex = args.length - 1;
      const handler = args[handlerIndex] as AnyFunction;
      args[handlerIndex] = (input: Record<string, unknown>, ...rest: unknown[]) => {
        const root = input["x-workspace-root"] as string | undefined;
        return workspaceContext.run(root ?? defaultRoot, () => handler(input, ...rest));
      };
      return original.apply(server, args);
    };
  }
  return () => workspaceContext.getStore() ?? defaultRoot;
}
