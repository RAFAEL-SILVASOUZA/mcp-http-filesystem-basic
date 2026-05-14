import express, { Request, Application } from "express";
import cors from "cors";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcpServer.js";
import { isAbsolute } from "path";
import crypto from "crypto";

// Store active transports by session ID for stateful connections
const transports = new Map<string, { transport: StreamableHTTPServerTransport; server: ReturnType<typeof createMcpServer> }>();

export function createExpressApp(): Application {
  const app = express();

  // CORS setup
  app.use(
    cors({
      origin: true,
      methods: ["GET", "POST", "OPTIONS", "DELETE"],
      allowedHeaders: [
        "Content-Type",
        "Content-Length",
        "Content-Encoding",
        "Mcp-Session-Id",
        "Mcp-Protocol-Version",
        "Authorization",
        "X-Workspace-Root",
      ],
      exposedHeaders: ["Mcp-Session-Id"],
    })
  );

  // Body parsing
  app.use((req, res, next) => {
    if (
      req.headers["content-type"]?.includes("application/json") &&
      req.headers["content-length"] &&
      Number(req.headers["content-length"]) > 0
    ) {
      express.json()(req, res, next);
    } else {
      req.body = {};
      next();
    }
  });

  // Helper to extract workspace root from request
  function getWorkspaceRoot(req: Request): string {
    const headerValue = req.headers["x-workspace-root"] as string | undefined;
    if (headerValue && headerValue.trim()) {
      return isAbsolute(headerValue) ? headerValue : process.cwd();
    }
    return process.cwd();
  }

  // MCP endpoint
  app.all("/mcp", async (req, res) => {
    const sessionId = (req.headers["mcp-session-id"] as string) || undefined;
    const workspaceRoot = getWorkspaceRoot(req);

    let transportEntry: { transport: StreamableHTTPServerTransport; server: ReturnType<typeof createMcpServer> };

    if (sessionId && transports.has(sessionId)) {
      // Reuse existing transport for this session
      transportEntry = transports.get(sessionId)!;
    } else {
      // Create new transport and server
      const server = createMcpServer(workspaceRoot);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: sessionId ? undefined : () => crypto.randomUUID(),
      });

      await server.connect(transport);
      transportEntry = { transport, server };

      // Store if a session ID was generated
      if (transport.sessionId) {
        transports.set(transport.sessionId, transportEntry);
        console.error(`[mcp] Session created: ${transport.sessionId}`);
      }
    }

    try {
      await transportEntry.transport.handleRequest(req, res, req.body);
      console.error(`[mcp] Request handled. Session: ${sessionId || "new"}`);
    } catch (error) {
      console.error(`[mcp] Error handling request:`, error);
    }
  });

  // Health check
  app.get("/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  return app;
}
