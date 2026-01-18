import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDefaultRegistry } from '../src/commands/registry.js';

function streamOf(items) {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

test('clawd.invoke posts to /tools/invoke and returns JSON', async () => {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/tools/invoke') {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    let body = '';
    req.setEncoding('utf8');
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      assert.equal(parsed.tool, 'demo');
      assert.equal(parsed.action, 'ping');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ ok: true, echo: parsed.args }]))
    });
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const registry = createDefaultRegistry();
    const cmd = registry.get('clawd.invoke');

    const result = await cmd.run({
      input: streamOf([]),
      args: {
        _: [],
        url: `http://127.0.0.1:${port}`,
        tool: 'demo',
        action: 'ping',
        'args-json': '{"hello":"world"}',
      },
      ctx: {
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        env: process.env,
        registry,
        mode: 'tool',
        render: { json() {}, lines() {} },
      },
    });

    const items = [];
    for await (const it of result.output) items.push(it);
    assert.deepEqual(items, [{ ok: true, echo: { hello: 'world' } }]);
  } finally {
    server.close();
  }
});
