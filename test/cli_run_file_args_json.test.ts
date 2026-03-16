import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

function runLobster(args: string[], opts?: { env?: Record<string, string | undefined> }) {
  const res = spawnSync(process.execPath, [path.join('bin', 'lobster.js'), ...args], {
    cwd: path.resolve('.'),
    env: { ...process.env, ...(opts?.env ?? undefined) },
    encoding: 'utf8',
  });
  return res;
}

test('cli: run --file passes --args-json into workflow args', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-cli-'));
  const filePath = path.join(tmpDir, 'workflow.lobster');

  // Print both template-substituted arg and env-injected arg (LOBSTER_ARG_TASK)
  // so we catch regressions in either path.
  const workflow = `name: test\nargs:\n  task:\n    default: ""\nsteps:\n  - id: s\n    command: >\n      node -e "process.stdout.write(JSON.stringify({task: '\${task}', env: process.env.LOBSTER_ARG_TASK}))"\n`;

  await fsp.writeFile(filePath, workflow, 'utf8');

  const res = runLobster([
    'run',
    '--file',
    filePath,
    '--args-json',
    '{"task":"test"}',
  ]);

  assert.equal(res.status, 0, `expected exit 0, got ${res.status}\nstdout=${res.stdout}\nstderr=${res.stderr}`);

  const parsed = JSON.parse(String(res.stdout).trim());
  assert.deepEqual(parsed, [{ task: 'test', env: 'test' }]);
});
