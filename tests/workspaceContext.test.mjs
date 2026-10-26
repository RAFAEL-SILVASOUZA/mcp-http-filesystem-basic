import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../dist/server/mcpServer.js';

// Exercise the shared workspace wrapper through the real MCP protocol.
test('workspace_argument_schema_precedence_validation_and_isolation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-workspace-'));
  const fallback = join(root, 'fallback');
  const override = join(root, 'override');
  await Promise.all([mkdir(fallback), mkdir(override)]);
  await Promise.all([
    writeFile(join(fallback, 'marker.txt'), 'fallback marker'),
    writeFile(join(override, 'marker.txt'), 'override marker'),
  ]);
  const server = createMcpServer(fallback);
  const client = new Client({ name: 'workspace-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await t.test('all_tools_expose_optional_workspace_argument', async () => {
      const { tools } = await client.listTools();
      assert.ok(tools.length > 5);
      for (const tool of tools) {
        assert.equal(tool.inputSchema.properties['x-workspace-root'].type, 'string', tool.name);
        assert.ok(!tool.inputSchema.required?.includes('x-workspace-root'), tool.name);
      }
    });
    await t.test('bootstrap_reports_call_workspace', async () => {
      const result = await client.callTool({ name: 'get-agent-instructions', arguments: { 'x-workspace-root': override } });
      assert.equal(result.isError, undefined);
      assert.ok(result.content[0].text.includes(`Workspace: ${override}`));
    });
    await t.test('override_and_fallback_are_isolated_in_concurrent_calls', async () => {
      const [a, b, c] = await Promise.all([
        client.callTool({ name: 'read-file', arguments: { path: 'marker.txt', 'x-workspace-root': override } }),
        client.callTool({ name: 'read-file', arguments: { path: 'marker.txt' } }),
        client.callTool({ name: 'read-file', arguments: { path: 'marker.txt', 'x-workspace-root': fallback } }),
      ]);
      for (const result of [a, b, c]) assert.ok(!result.isError);
      assert.match(a.content[0].text, /override marker/);
      assert.match(b.content[0].text, /fallback marker/);
      assert.match(c.content[0].text, /fallback marker/);
    });
    await t.test('invalid_workspace_is_rejected_for_modern_and_legacy_tools', async () => {
      for (const name of ['read-file', 'get-system-info']) {
        for (const value of ['relative/path', '', 123]) {
          const result = await client.callTool({ name, arguments: { path: 'marker.txt', 'x-workspace-root': value } });
          assert.equal(result.isError, true, `${name}: ${value}`);
        }
      }
    });
    await t.test('legacy_tool_accepts_workspace_argument', async () => {
      const result = await client.callTool({ name: 'get-system-info', arguments: { 'x-workspace-root': override } });
      assert.ok(!result.isError);
      assert.equal(JSON.parse(result.content[0].text).os.platform, process.platform);
    });
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
