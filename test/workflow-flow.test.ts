import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runWorkflowFile } from '../src/workflows/file.js';
import { decodeResumeToken } from '../src/resume.js';

const testCtx = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  mode: 'tool' as const,
};

async function writeTmpWorkflow(
  name: string,
  contentFn: (dir: string) => object,
): Promise<{ filePath: string; env: Record<string, string | undefined>; dir: string }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-flow-'));
  const stateDir = path.join(dir, 'state');
  const filePath = path.join(dir, `${name}.lobster`);
  const content = contentFn(dir);
  await fsp.writeFile(filePath, JSON.stringify(content), 'utf8');
  return { filePath, env: { ...process.env, LOBSTER_STATE_DIR: stateDir }, dir };
}

test('flow: forward jump skips intermediate steps', async () => {
  const { filePath, env } = await writeTmpWorkflow('forward-jump', () => ({
    steps: [
      {
        id: 'a',
        command: 'node -e "process.stdout.write(JSON.stringify({jump:true}))"',
        flow: [{ when: '$a.json.jump == true', goto: 'c' }],
      },
      {
        id: 'b',
        command: 'node -e "process.stdout.write(JSON.stringify({ran:true}))"',
      },
      {
        id: 'c',
        command: 'node -e "process.stdout.write(JSON.stringify({done:true}))"',
      },
    ],
  }));

  const result = await runWorkflowFile({ filePath, ctx: { ...testCtx, env } });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, [{ done: true }]);
});

test('flow: backward jump creates a loop', async () => {
  const { filePath, env } = await writeTmpWorkflow('loop', (d) => {
    const cntFile = path.join(d, 'cnt.txt');
    return {
      steps: [
        {
          id: 'counter',
          command: `node -e "const fs=require('fs'); const f='${cntFile}'; const c=(fs.existsSync(f)?parseInt(fs.readFileSync(f,'utf8')):0)+1; fs.writeFileSync(f,String(c)); process.stdout.write(JSON.stringify({count:c}))"`,
          flow: [
            { when: '$counter.json.count >= 3', goto: 'done' },
            { default: 'counter' },
          ],
          max_iterations: 10,
        },
        {
          id: 'done',
          command: 'node -e "process.stdout.write(JSON.stringify({finished:true}))"',
        },
      ],
    };
  });

  const result = await runWorkflowFile({ filePath, ctx: { ...testCtx, env } });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, [{ finished: true }]);
});

test('flow: default fallback when condition is false', async () => {
  const { filePath, env } = await writeTmpWorkflow('default-fallback', () => ({
    steps: [
      {
        id: 'a',
        command: 'node -e "process.stdout.write(JSON.stringify({skip:true}))"',
        flow: [
          { when: '$a.json.skip == false', goto: 'b' },
          { default: 'b' },
        ],
      },
      {
        id: 'b',
        command: 'node -e "process.stdout.write(JSON.stringify({done:true}))"',
      },
    ],
  }));

  const result = await runWorkflowFile({ filePath, ctx: { ...testCtx, env } });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, [{ done: true }]);
});

test('flow: no match advances normally', async () => {
  const { filePath, env } = await writeTmpWorkflow('no-match', () => ({
    steps: [
      {
        id: 'a',
        command: 'node -e "process.stdout.write(JSON.stringify({x:1}))"',
        flow: [{ when: '$a.json.x == 99', goto: 'a' }],
      },
      {
        id: 'b',
        command: 'node -e "process.stdout.write(JSON.stringify({next:true}))"',
      },
    ],
  }));

  const result = await runWorkflowFile({ filePath, ctx: { ...testCtx, env } });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, [{ next: true }]);
});

test('flow: max_iterations hard error', async () => {
  const { filePath, env } = await writeTmpWorkflow('max-iter', () => ({
    steps: [
      {
        id: 'loop',
        command: 'node -e "process.stdout.write(JSON.stringify({going:true}))"',
        max_iterations: 3,
        flow: [{ default: 'loop' }],
      },
    ],
  }));

  await assert.rejects(
    () => runWorkflowFile({ filePath, ctx: { ...testCtx, env } }),
    /max_iterations|exceeded/i,
  );
});

test('flow: skipped steps do not evaluate flow', async () => {
  // A is skipped (when=false). Its flow [default:'c'] should NOT fire.
  // If flow fires: jump to C, B is invisible → B marker file NOT written
  // If flow doesn't fire: B runs → B marker file written, then C runs
  const { filePath, env, dir } = await writeTmpWorkflow('skip-flow', (d) => {
    const markerFile = path.join(d, 'b_ran');
    return {
      steps: [
        {
          id: 'a',
          command: 'node -e "process.stdout.write(JSON.stringify({x:1}))"',
          when: false,
          flow: [{ default: 'c' }],
        },
        {
          id: 'b',
          command: `node -e "require('fs').writeFileSync('${markerFile}','1'); process.stdout.write(JSON.stringify({ran:true}))"`,
        },
        {
          id: 'c',
          command: 'node -e "process.stdout.write(JSON.stringify({jumped:true}))"',
        },
      ],
    };
  });

  const result = await runWorkflowFile({ filePath, ctx: { ...testCtx, env } });
  assert.equal(result.status, 'ok');
  // C is last step (runs after B in correct case)
  assert.deepEqual(result.output, [{ jumped: true }]);
  // Verify B actually ran (proves flow on A was NOT evaluated)
  const bRan = await fsp.access(path.join(dir, 'b_ran')).then(() => true, () => false);
  assert.equal(bRan, true, 'Step B should have run (A was skipped, its flow not evaluated)');
});

test('flow: visit counters persist across halt/resume', async () => {
  const { filePath, env } = await writeTmpWorkflow('visit-persist', () => ({
    steps: [
      {
        id: 'check',
        command: 'node -e "process.stdout.write(JSON.stringify({requiresApproval:{prompt:\'Approve?\',items:[]}}))"',
        approval: 'required',
        max_iterations: 5,
        flow: [{ default: 'check' }],
      },
    ],
  }));

  // First run — halts for approval (visit 1)
  const first = await runWorkflowFile({ filePath, ctx: { ...testCtx, env } });
  assert.equal(first.status, 'needs_approval');
  const payload1 = decodeResumeToken(first.requiresApproval?.resumeToken ?? '');

  // Resume — flow loops back to check, so command runs again (visit 2)
  const second = await runWorkflowFile({ filePath, ctx: { ...testCtx, env }, resume: payload1, approved: true });
  assert.equal(second.status, 'needs_approval'); // visit 2, halts again

  const payload2 = decodeResumeToken(second.requiresApproval?.resumeToken ?? '');

  // Continue resuming until max_iterations
  let current = payload2;
  let hitLimit = false;
  for (let i = 0; i < 5; i++) {
    try {
      const r = await runWorkflowFile({ filePath, ctx: { ...testCtx, env }, resume: current, approved: true });
      if (r.status === 'needs_approval') {
        current = decodeResumeToken(r.requiresApproval?.resumeToken ?? '');
      }
    } catch (e: unknown) {
      if (e instanceof Error && /max_iterations|exceeded/i.test(e.message)) {
        hitLimit = true;
        break;
      }
      throw e;
    }
  }
  assert.equal(hitLimit, true);
});
