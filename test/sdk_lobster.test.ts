import test from 'node:test';
import assert from 'node:assert/strict';

import { Lobster } from '../src/sdk/Lobster.js';

test('sdk Lobster.resume supports cancel for input requests', async () => {
  const workflow = new Lobster().pipe({
    async run() {
      return {
        halt: true,
        output: (async function* () {
          yield {
            type: 'input_request',
            prompt: 'Decision?',
            responseSchema: {
              type: 'object',
              properties: { decision: { type: 'string' } },
              required: ['decision'],
            },
            subject: { text: 'draft v1' },
          };
        })(),
      };
    },
  });

  const first = await workflow.run();
  assert.equal(first.ok, true);
  assert.equal(first.status, 'needs_input');
  assert.ok(first.requiresInput?.resumeToken);

  const cancelled = await workflow.resume(first.requiresInput!.resumeToken, { cancel: true });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(cancelled.output, []);
});

test('sdk Lobster.resume enforces a single resume intent', async () => {
  const workflow = new Lobster().pipe({
    async run() {
      return {
        halt: true,
        output: (async function* () {
          yield {
            type: 'input_request',
            prompt: 'Decision?',
            responseSchema: { type: 'string' },
            subject: { text: 'draft v1' },
          };
        })(),
      };
    },
  });

  const first = await workflow.run();
  assert.equal(first.status, 'needs_input');
  await assert.rejects(
    () =>
      workflow.resume(first.requiresInput!.resumeToken, {
        cancel: true,
        response: 'approve',
      }),
    /only one of approved, response, or cancel/i,
  );
});

test('sdk Lobster.resume cancel still validates resume token', async () => {
  const workflow = new Lobster();
  await assert.rejects(
    () => workflow.resume('not-a-token', { cancel: true }),
    /invalid token/i,
  );
  const structurallyInvalid = Buffer.from(JSON.stringify({ protocolVersion: 1, v: 1 }), 'utf8').toString('base64url');
  await assert.rejects(
    () => workflow.resume(structurallyInvalid, { cancel: true }),
    /invalid token/i,
  );
});

test('sdk Lobster.resume accepts valid structured input responses', async () => {
  const workflow = new Lobster().pipe({
    async run() {
      return {
        halt: true,
        output: (async function* () {
          yield {
            type: 'input_request',
            prompt: 'Decision?',
            responseSchema: {
              type: 'object',
              properties: { decision: { type: 'string', enum: ['approve', 'reject'] } },
              required: ['decision'],
            },
            subject: { text: 'draft v1' },
          };
        })(),
      };
    },
  });

  const first = await workflow.run();
  assert.equal(first.ok, true);
  assert.equal(first.status, 'needs_input');
  assert.ok(first.requiresInput?.resumeToken);

  const resumed = await workflow.resume(first.requiresInput!.resumeToken, {
    response: { decision: 'approve' },
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.status, 'ok');
  assert.deepEqual(resumed.output, [{ decision: 'approve' }]);
});

test('sdk Lobster.resume rejects invalid structured input responses', async () => {
  const workflow = new Lobster().pipe({
    async run() {
      return {
        halt: true,
        output: (async function* () {
          yield {
            type: 'input_request',
            prompt: 'Decision?',
            responseSchema: {
              type: 'object',
              properties: { decision: { type: 'string', enum: ['approve', 'reject'] } },
              required: ['decision'],
            },
            subject: { text: 'draft v1' },
          };
        })(),
      };
    },
  });

  const first = await workflow.run();
  assert.equal(first.status, 'needs_input');
  await assert.rejects(
    () =>
      workflow.resume(first.requiresInput!.resumeToken, {
        response: { decision: 'maybe' },
      }),
    /does not match schema/i,
  );
});

test('sdk Lobster.resume treats boolean schemas as input resumes', async () => {
  const workflow = new Lobster().pipe({
    async run() {
      return {
        halt: true,
        output: (async function* () {
          yield {
            type: 'input_request',
            prompt: 'Provide anything',
            responseSchema: true,
            subject: { text: 'draft v1' },
          };
        })(),
      };
    },
  });

  const first = await workflow.run();
  assert.equal(first.status, 'needs_input');
  const resumed = await workflow.resume(first.requiresInput!.resumeToken, {
    response: { any: 'value' },
  });
  assert.equal(resumed.status, 'ok');
  assert.deepEqual(resumed.output, [{ any: 'value' }]);
});

test('sdk Lobster.resume validates false boolean schemas as input resumes', async () => {
  const workflow = new Lobster().pipe({
    async run() {
      return {
        halt: true,
        output: (async function* () {
          yield {
            type: 'input_request',
            prompt: 'Provide anything',
            responseSchema: false,
            subject: { text: 'draft v1' },
          };
        })(),
      };
    },
  });

  const first = await workflow.run();
  assert.equal(first.status, 'needs_input');
  await assert.rejects(
    () =>
      workflow.resume(first.requiresInput!.resumeToken, {
        response: { any: 'value' },
      }),
    /does not match schema/i,
  );
});
