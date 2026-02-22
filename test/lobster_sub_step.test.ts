import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runWorkflowFile } from '../src/workflows/file.js';

const ctx = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env as Record<string, string | undefined>,
  mode: 'tool' as const,
};

async function writeTmp(dir: string, name: string, content: unknown) {
  const filePath = path.join(dir, name);
  await fsp.writeFile(filePath, JSON.stringify(content, null, 2), 'utf8');
  return filePath;
}

test('lobster sub-step runs a sub-workflow and captures its output', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-sub-'));

  const subWorkflow = {
    args: { greeting: { default: 'hello' } },
    steps: [
      { id: 'say', command: 'echo "${greeting} world"' },
    ],
  };
  await writeTmp(tmpDir, 'sub.lobster', subWorkflow);

  const mainWorkflow = {
    steps: [
      { id: 'greet', lobster: './sub.lobster', args: { greeting: 'hi' } },
    ],
  };
  const mainPath = await writeTmp(tmpDir, 'main.lobster', mainWorkflow);

  const result = await runWorkflowFile({ filePath: mainPath, ctx });
  assert.equal(result.status, 'ok');
  assert.equal((result.output[0] as string).trim(), 'hi world');
});

test('lobster sub-step passes parent step output as args', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-sub-'));

  const subWorkflow = {
    args: { value: { default: '' } },
    steps: [
      { id: 'out', command: 'echo "received:${value}"' },
    ],
  };
  await writeTmp(tmpDir, 'sub.lobster', subWorkflow);

  const mainWorkflow = {
    steps: [
      { id: 'produce', command: 'echo "myvalue"' },
      { id: 'consume', lobster: './sub.lobster', args: { value: '$produce.stdout' } },
    ],
  };
  const mainPath = await writeTmp(tmpDir, 'main.lobster', mainWorkflow);

  const result = await runWorkflowFile({ filePath: mainPath, ctx });
  assert.equal(result.status, 'ok');
  assert.match(result.output[0] as string, /received:myvalue/);
});

test('lobster sub-step loop runs exactly maxIterations times when no condition', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-loop-'));

  const counterFile = path.join(tmpDir, 'count.txt');
  await fsp.writeFile(counterFile, '0', 'utf8');

  const subWorkflow = {
    steps: [
      { id: 'inc', command: `c=$(cat ${counterFile}); echo $((c+1)) | tee ${counterFile}` },
    ],
  };
  await writeTmp(tmpDir, 'sub.lobster', subWorkflow);

  const mainWorkflow = {
    steps: [
      { id: 'loop', lobster: './sub.lobster', loop: { maxIterations: 3 } },
    ],
  };
  const mainPath = await writeTmp(tmpDir, 'main.lobster', mainWorkflow);

  const result = await runWorkflowFile({ filePath: mainPath, ctx });
  assert.equal(result.status, 'ok');

  const finalCount = parseInt((await fsp.readFile(counterFile, 'utf8')).trim(), 10);
  assert.equal(finalCount, 3);
});

test('lobster sub-step loop stops when condition exits non-zero', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-cond-'));

  const counterFile = path.join(tmpDir, 'count.txt');
  await fsp.writeFile(counterFile, '0', 'utf8');

  const subWorkflow = {
    steps: [
      { id: 'inc', command: `c=$(cat ${counterFile}); echo $((c+1)) | tee ${counterFile}` },
    ],
  };
  await writeTmp(tmpDir, 'sub.lobster', subWorkflow);

  // Condition: continue while LOBSTER_LOOP_ITERATION < 2 (stop after 2nd iteration)
  const mainWorkflow = {
    steps: [
      {
        id: 'loop',
        lobster: './sub.lobster',
        loop: {
          maxIterations: 10,
          condition: '[ "$LOBSTER_LOOP_ITERATION" -lt 2 ]',
        },
      },
    ],
  };
  const mainPath = await writeTmp(tmpDir, 'main.lobster', mainWorkflow);

  const result = await runWorkflowFile({ filePath: mainPath, ctx });
  assert.equal(result.status, 'ok');

  const finalCount = parseInt((await fsp.readFile(counterFile, 'utf8')).trim(), 10);
  assert.equal(finalCount, 2);
});

test('lobster sub-step loop condition uses LOBSTER_LOOP_STDOUT', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-stdout-'));

  const counterFile = path.join(tmpDir, 'count.txt');
  await fsp.writeFile(counterFile, '0', 'utf8');

  // Sub-workflow: increment counter and echo "done" when count reaches 3
  const subWorkflow = {
    steps: [
      {
        id: 'step',
        command: `c=$(cat ${counterFile}); n=$((c+1)); echo $n > ${counterFile}; if [ $n -ge 3 ]; then echo "done"; else echo "continue"; fi`,
      },
    ],
  };
  await writeTmp(tmpDir, 'sub.lobster', subWorkflow);

  // Condition: continue while stdout is NOT "done"
  const mainWorkflow = {
    steps: [
      {
        id: 'loop',
        lobster: './sub.lobster',
        loop: {
          maxIterations: 10,
          condition: '! echo "$LOBSTER_LOOP_STDOUT" | grep -q "^done"',
        },
      },
    ],
  };
  const mainPath = await writeTmp(tmpDir, 'main.lobster', mainWorkflow);

  const result = await runWorkflowFile({ filePath: mainPath, ctx });
  assert.equal(result.status, 'ok');

  const finalCount = parseInt((await fsp.readFile(counterFile, 'utf8')).trim(), 10);
  assert.equal(finalCount, 3);
  assert.match(result.output[0] as string, /done/);
});

test('loadWorkflowFile rejects lobster step without file', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-val-'));

  const workflow = {
    steps: [
      { id: 'bad', lobster: '' },
    ],
  };
  const filePath = await writeTmp(tmpDir, 'workflow.lobster', workflow);

  await assert.rejects(
    () => runWorkflowFile({ filePath, ctx }),
    /'lobster' must be a non-empty file path/,
  );
});
