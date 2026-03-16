import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createDefaultRegistry } from '../src/commands/registry.js';

function streamOf(items: any[]) {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

async function collect(iterable: AsyncIterable<any>) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

test('llm.invoke auto-detects OpenClaw provider and normalizes output', async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get('llm.invoke');
  assert.ok(cmd, 'llm.invoke should be registered');
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'lobster-cache-'));

  const bodyLog: any[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/tools/invoke') {
      res.writeHead(404);
      res.end('nope');
      return;
    }
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (d) => (buf += d));
    req.on('end', () => {
      const parsed = JSON.parse(buf || '{}');
      bodyLog.push(parsed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            ok: true,
            result: {
              runId: 'invoke_1',
              model: parsed.args?.model,
              prompt: parsed.args?.prompt,
              output: { data: { summary: 'hello' } },
            },
          },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  try {
    const result = await cmd.run({
      input: streamOf([{ kind: 'text', text: 'doc' }]),
      args: {
        _: [],
        model: 'claude-3-sonnet',
        prompt: 'Summarize',
      },
      ctx: baseCtx({ OPENCLAW_URL: `http://localhost:${port}`, LOBSTER_CACHE_DIR: cacheDir }, registry),
    } as any);

    const items = await collect(result.output!);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, 'llm.invoke');
    assert.equal(items[0].source, 'openclaw');
    assert.equal(items[0].runId, 'invoke_1');
    assert.equal(items[0].output.data.summary, 'hello');
    assert.equal(bodyLog.length, 1);
    assert.equal(bodyLog[0].tool, 'llm-task');
    assert.equal(bodyLog[0].args.prompt, 'Summarize');
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

test('llm.invoke uses Pi adapter over local HTTP bridge', async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get('llm.invoke');
  assert.ok(cmd);
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'lobster-cache-'));

  const requestLog: any[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/invoke') {
      res.writeHead(404);
      res.end('nope');
      return;
    }
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (d) => (buf += d));
    req.on('end', () => {
      const parsed = JSON.parse(buf || '{}');
      requestLog.push(parsed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            runId: 'pi_1',
            model: parsed.model,
            prompt: parsed.prompt,
            output: {
              format: 'json',
              text: '{"decision":"reply"}',
              data: { decision: 'reply' },
            },
            diagnostics: { adapter: 'pi' },
          },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  try {
    const result = await cmd.run({
      input: streamOf([{ kind: 'text', text: 'draft this' }]),
      args: {
        _: [],
        provider: 'pi',
        prompt: 'Decide',
        'output-schema': '{"type":"object","required":["decision"]}',
      },
      ctx: baseCtx(
        {
          LOBSTER_PI_LLM_ADAPTER_URL: `http://127.0.0.1:${port}`,
          LOBSTER_LLM_MODEL: 'anthropic/claude-sonnet-4-5',
          LOBSTER_CACHE_DIR: cacheDir,
        },
        registry,
      ),
    } as any);

    const items = await collect(result.output!);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, 'llm.invoke');
    assert.equal(items[0].source, 'pi');
    assert.equal(items[0].model, 'anthropic/claude-sonnet-4-5');
    assert.equal(items[0].output.data.decision, 'reply');
    assert.equal(requestLog.length, 1);
    assert.equal(requestLog[0].prompt, 'Decide');
    assert.equal(requestLog[0].model, 'anthropic/claude-sonnet-4-5');
    assert.equal(requestLog[0].artifacts.length, 1);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
    await closeServer(server);
  }
});

function baseCtx(envOverrides: Record<string, string>, registry?: any) {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: { ...process.env, ...envOverrides },
    registry: registry ?? null,
    mode: 'tool',
    render: { json() {}, lines() {} },
  };
}

async function closeServer(server: http.Server) {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
