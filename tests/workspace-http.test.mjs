import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// E2E: um cliente HTTP puro, que NÃO pode enviar headers, define o workspace
// pelo argumento x-workspace-root em cada chamada. Sobe o servidor real via tsx.
const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const PORT = 3199;
const URL_PATH = "/mcp";

function post(port, body, sessionId) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        port,
        path: URL_PATH,
        method: "POST",
        agent: false,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          const line = raw.split("\n").find((l) => l.startsWith("data:")) ?? raw;
          resolve({
            sessionId: res.headers["mcp-session-id"],
            json: line.trim() ? JSON.parse(line.replace(/^data:\s*/, "")) : {},
          });
        });
      }
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

async function waitForServer(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const req = http.request({ port, path: "/health", method: "GET", agent: false }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on("error", () => resolve(false));
      req.end();
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`servidor não subiu em ${timeoutMs}ms`);
}

test("http_client_without_header_sets_workspace_per_call", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mcp-http-e2e-"));
  await mkdir(join(root, "sub"));
  await writeFile(join(root, "sub", "marker.txt"), "marker via argumento");

  const server = spawn(
    process.execPath,
    ["--import", "tsx", join(repoRoot, "src", "index.ts")],
    {
      cwd: repoRoot,
      stdio: "ignore",
      env: { ...process.env, PORT: String(PORT) },
    }
  );
  server.stderr?.resume();

  try {
    await waitForServer(PORT);

    let sessionId;
    const rpc = async (method, params, id) => {
      const res = await post(PORT, { jsonrpc: "2.0", id, method, params }, sessionId);
      if (!sessionId && res.sessionId) sessionId = res.sessionId;
      return res.json;
    };

    await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "no-header-client", version: "1.0.0" },
    }, 1);
    await rpc("notifications/initialized", {}, undefined);

    await t.test("toda_tool_expone_x_workspace_root", async () => {
      const { tools } = (await rpc("tools/list", {}, 2)).result;
      assert.ok(tools.length > 5);
      const missing = tools.filter((tool) => !tool.inputSchema.properties?.["x-workspace-root"]);
      assert.deepEqual(missing.map((tool) => tool.name), []);
      const required = tools.filter((tool) => tool.inputSchema.required?.includes("x-workspace-root"));
      assert.deepEqual(required.map((tool) => tool.name), [], "o argumento deve continuar opcional");
    });

    await t.test("leitura_usa_o_workspace_do_argumento", async () => {
      const result = (
        await rpc("tools/call", {
          name: "read-file",
          arguments: { path: "sub/marker.txt", "x-workspace-root": root },
        }, 3)
      ).result;
      assert.equal(result.isError, undefined);
      assert.match(result.content[0].text, /marker via argumento/);
    });

    await t.test("shell_e_glob_usam_o_workspace_do_argumento", async () => {
      const glob = (
        await rpc("tools/call", { name: "file-glob", arguments: { path: ".", "x-workspace-root": root } }, 4)
      ).result;
      assert.match(glob.content[0].text.replace(/\\\\/g, "/"), new RegExp(root.replace(/\\/g, "/")));

      const shell = (
        await rpc("tools/call", { name: "execute_command", arguments: { command: "cd", "x-workspace-root": root } }, 5)
      ).result;
      assert.equal(shell.isError, undefined);
      assert.ok(shell.content[0].text.includes(root), shell.content[0].text.slice(0, 200));
    });

    await t.test("sem_argumento_e_sem_header_cai_no_padrao_do_servidor", async () => {
      const result = (
        await rpc("tools/call", { name: "read-file", arguments: { path: "sub/marker.txt" } }, 6)
      ).result;
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /outside the workspace root|no such file/i);
    });
  } finally {
    server.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
  }
});
