import { createExpressApp } from "./server/express.js";

const PORT = parseInt(process.env.PORT || "3001", 10);

const app = createExpressApp();

app.listen(PORT, () => {
  console.error(`[mcp] MCP server listening on port ${PORT}`);
});
