import { sharedAjv } from '../../validation.js';

function isInteractive(stdin) {
  return Boolean(stdin.isTTY);
}

function compileAskValidator(schema) {
  try {
    return sharedAjv.compile(schema);
  } catch {
    throw new Error('ask response schema is invalid');
  }
}

function validateAskResponse(validator, response) {
  const ok = validator(response);
  if (ok) return;
  const first = validator.errors?.[0];
  const pathValue = first?.instancePath || '/';
  const reason = first?.message ? ` ${first.message}` : '';
  throw new Error(`ask response failed schema validation at ${pathValue}:${reason}`);
}

function parseInteractiveCandidates(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [text, { decision: text }];
  }
  if (typeof parsed === 'string') {
    return [parsed, { decision: parsed }];
  }
  return [parsed];
}

export const askCommand = {
  name: 'ask',
  meta: {
    description: 'Pause and request structured input from the user',
    argsSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Question or instruction to show', default: 'Input required' },
        schema: { type: 'string', description: 'JSON Schema string for the expected response' },
        'subject-from-stdin': { type: 'boolean', description: 'Use stdin content as the subject (preview text)' },
        emit: { type: 'boolean', description: 'Force emit mode' },
        _: { type: 'array', items: { type: 'string' } },
      },
      required: [],
    },
    sideEffects: [],
  },
  help() {
    return [
      'ask — pause and request structured input from the user',
      '',
      'Usage:',
      '  ... | ask --prompt "Approve, reject, or send feedback:"',
      '  ... | ask --prompt "Feedback?" --schema \'{"type":"object","properties":{"decision":{"type":"string"},"feedback":{"type":"string"}},"required":["decision"]}\'',
      '  ... | ask --subject-from-stdin --prompt "Review this draft:"',
      '',
      'Notes:',
      '  - In tool mode (or non-interactive), emits a needs_input envelope and halts.',
      '  - Use --schema to constrain the response shape (JSON Schema).',
      '  - Use --subject-from-stdin to embed the current pipeline value as preview text.',
    ].join('\n');
  },
  async run({ input, args, ctx }) {
    const prompt = typeof args.prompt === 'string' ? args.prompt : 'Input required';
    const subjectFromStdin = Boolean(args['subject-from-stdin'] ?? args.subjectFromStdin);
    const schemaRaw = typeof args.schema === 'string' ? args.schema : null;

    const items = [];
    for await (const item of input) items.push(item);

    const defaultSchema = {
      type: 'object',
      properties: {
        decision: { type: 'string', enum: ['approve', 'reject', 'redraft'] },
        feedback: { type: 'string', description: 'Feedback for redraft' },
      },
      required: ['decision'],
    };

    let responseSchema = defaultSchema;
    if (schemaRaw) {
      let parsedSchema;
      try {
        parsedSchema = JSON.parse(schemaRaw);
      } catch {
        throw new Error('ask --schema must be valid JSON');
      }
      if (!parsedSchema || typeof parsedSchema !== 'object' || Array.isArray(parsedSchema)) {
        throw new Error('ask --schema must decode to a JSON schema object');
      }
      responseSchema = parsedSchema;
    }
    const responseValidator = compileAskValidator(responseSchema);

    let subject;
    if (subjectFromStdin && items.length > 0) {
      const preview = items
        .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
        .join('\n')
        .slice(0, 2000);
      subject = { text: preview };
    }

    const emit = Boolean(args.emit) || ctx.mode === 'tool' || !isInteractive(ctx.stdin);
    if (emit) {
      return {
        halt: true,
        output: (async function* () {
          yield {
            type: 'input_request',
            prompt,
            responseSchema,
            ...(subject ? { subject } : null),
            items,
          };
        })(),
      };
    }

    ctx.stdout.write(`${prompt}\n> `);
    const { readLineFromStream } = await import('../../read_line.js');
    const raw = await readLineFromStream(ctx.stdin, { timeoutMs: 0 });
    const text = String(raw ?? '').trim();

    let lastError;
    for (const candidate of parseInteractiveCandidates(text)) {
      try {
        validateAskResponse(responseValidator, candidate);
        return { output: (async function* () { yield candidate; })() };
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError ?? new Error('ask response failed schema validation');
  },
};
