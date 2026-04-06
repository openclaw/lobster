import { runPipelineInternal } from './runtime.js';
import { encodeToken, decodeToken } from './token.js';
import { sharedAjv } from '../validation.js';

type SdkResumePayload = {
  protocolVersion: 1;
  v: 1;
  stageIndex?: number;
  resumeAtIndex: number;
  items?: unknown[];
  prompt?: string;
  inputSchema?: unknown;
  inputSubject?: unknown;
};

/**
 * @typedef {Object} LobsterResult
 * @property {boolean} ok - Whether the workflow completed successfully
 * @property {'ok' | 'needs_approval' | 'needs_input' | 'cancelled' | 'error'} status - Workflow status
 * @property {any[]} output - Output items from the workflow
 * @property {Object|null} requiresApproval - Approval request if halted
 * @property {string} [requiresApproval.prompt] - Approval prompt
 * @property {any[]} [requiresApproval.items] - Items pending approval
 * @property {string} [requiresApproval.resumeToken] - Token to resume workflow
 * @property {Object|null} requiresInput - Input request if halted
 * @property {string} [requiresInput.prompt] - Input prompt
 * @property {Object} [requiresInput.responseSchema] - JSON Schema for response
 * @property {any} [requiresInput.subject] - Subject shown to the human
 * @property {string} [requiresInput.resumeToken] - Token to resume workflow
 * @property {Object} [error] - Error details if failed
 */

/**
 * @typedef {Object} LobsterOptions
 * @property {Object} [env] - Environment variables
 * @property {string} [stateDir] - State directory override
 */

export class Lobster {
  #stages = [];
  #options: any = {} as any;
  #meta = null;

  constructor(options: any = {}) {
    this.#options = {
      env: options.env ?? process.env,
      stateDir: options.stateDir,
    };
  }

  pipe(stage) {
    if (typeof stage !== 'function' && typeof stage?.run !== 'function') {
      throw new Error('Stage must be a function or have a run() method');
    }
    this.#stages.push(stage);
    return this;
  }

  meta(meta) {
    this.#meta = meta;
    return this;
  }

  getMeta() {
    return this.#meta;
  }

  async run(initialInput = []) {
    const ctx = {
      env: this.#options.env,
      stateDir: this.#options.stateDir,
      mode: 'sdk',
    };

    try {
      const result = await runPipelineInternal({
        stages: this.#stages,
        ctx,
        input: initialInput,
      });

      if (result.halted && result.items.length === 1 && result.items[0]?.type === 'approval_request') {
        const approval = result.items[0];
        const resumeToken = encodeToken({
          protocolVersion: 1,
          v: 1,
          stageIndex: result.haltedAt?.index ?? -1,
          resumeAtIndex: (result.haltedAt?.index ?? -1) + 1,
          items: approval.items,
          prompt: approval.prompt,
        });

        return {
          ok: true,
          status: 'needs_approval',
          output: [],
          requiresApproval: {
            prompt: approval.prompt,
            items: approval.items,
            resumeToken,
          },
          requiresInput: null,
        };
      }

      if (result.halted && result.items.length === 1 && result.items[0]?.type === 'input_request') {
        const input = result.items[0];
        const resumeToken = encodeToken({
          protocolVersion: 1,
          v: 1,
          stageIndex: result.haltedAt?.index ?? -1,
          resumeAtIndex: (result.haltedAt?.index ?? -1) + 1,
          items: [],
          inputSchema: input.responseSchema,
          inputSubject: input.subject,
        });

        return {
          ok: true,
          status: 'needs_input',
          output: [],
          requiresApproval: null,
          requiresInput: {
            prompt: input.prompt,
            responseSchema: input.responseSchema,
            defaults: input.defaults,
            subject: input.subject,
            resumeToken,
          },
        };
      }

      return {
        ok: true,
        status: 'ok',
        output: result.items,
        requiresApproval: null,
        requiresInput: null,
      };
    } catch (err) {
      return {
        ok: false,
        status: 'error',
        output: [],
        requiresApproval: null,
        requiresInput: null,
        error: {
          type: 'runtime_error',
          message: err?.message ?? String(err),
        },
      };
    }
  }

  async resume(
    token: string,
    options: { approved?: boolean; response?: unknown; cancel?: boolean } = {},
  ) {
    const { approved, response, cancel } = options;
    const intentCount = Number(typeof approved === 'boolean') + Number(response !== undefined) + Number(cancel === true);
    if (intentCount > 1) {
      throw new Error('resume accepts only one of approved, response, or cancel');
    }
    if (intentCount === 0) {
      throw new Error('resume requires approved, response, or cancel');
    }

    const payload = decodeSdkResumePayload(token);

    if (cancel === true) {
      return {
        ok: true,
        status: 'cancelled',
        output: [],
        requiresApproval: null,
        requiresInput: null,
      };
    }

    const expectsInput = payload.inputSchema !== undefined;
    if (expectsInput) {
      if (approved !== undefined) {
        throw new Error('resume token expects an input response, not approved');
      }
      if (response === undefined) {
        throw new Error('resume token expects response');
      }
    } else {
      if (response !== undefined) {
        throw new Error('resume token expects approved=true|false, not response');
      }
      if (typeof approved !== 'boolean') {
        throw new Error('resume token expects approved=true|false');
      }
      if (approved === false) {
        return {
          ok: true,
          status: 'cancelled',
          output: [],
          requiresApproval: null,
          requiresInput: null,
        };
      }
    }

    const resumeIndex = payload.resumeAtIndex ?? 0;
    let resumeItems = payload.items ?? [];
    if (response !== undefined) {
      const schema = payload.inputSchema;
      if (schema === undefined) {
        throw new Error('resume token does not support input responses');
      }
      let validator;
      try {
        validator = sharedAjv.compile(schema as any);
      } catch {
        throw new Error('resume token input schema is invalid');
      }
      const ok = validator(response);
      if (!ok) {
        const first = validator.errors?.[0];
        throw new Error(`response does not match schema at ${first?.instancePath || '/'}: ${first?.message || 'invalid'}`);
      }
      resumeItems = [response];
    }

    const remainingStages = this.#stages.slice(resumeIndex);
    const ctx = {
      env: this.#options.env,
      stateDir: this.#options.stateDir,
      mode: 'sdk',
    };

    try {
      const result = await runPipelineInternal({
        stages: remainingStages,
        ctx,
        input: resumeItems,
      });

      if (result.halted && result.items.length === 1 && result.items[0]?.type === 'approval_request') {
        const approval = result.items[0];
        const resumeToken = encodeToken({
          protocolVersion: 1,
          v: 1,
          stageIndex: resumeIndex + (result.haltedAt?.index ?? 0),
          resumeAtIndex: resumeIndex + (result.haltedAt?.index ?? 0) + 1,
          items: approval.items,
          prompt: approval.prompt,
        });

        return {
          ok: true,
          status: 'needs_approval',
          output: [],
          requiresApproval: {
            prompt: approval.prompt,
            items: approval.items,
            resumeToken,
          },
          requiresInput: null,
        };
      }

      if (result.halted && result.items.length === 1 && result.items[0]?.type === 'input_request') {
        const input = result.items[0];
        const resumeToken = encodeToken({
          protocolVersion: 1,
          v: 1,
          stageIndex: resumeIndex + (result.haltedAt?.index ?? 0),
          resumeAtIndex: resumeIndex + (result.haltedAt?.index ?? 0) + 1,
          items: [],
          inputSchema: input.responseSchema,
          inputSubject: input.subject,
        });

        return {
          ok: true,
          status: 'needs_input',
          output: [],
          requiresApproval: null,
          requiresInput: {
            prompt: input.prompt,
            responseSchema: input.responseSchema,
            defaults: input.defaults,
            subject: input.subject,
            resumeToken,
          },
        };
      }

      return {
        ok: true,
        status: 'ok',
        output: result.items,
        requiresApproval: null,
        requiresInput: null,
      };
    } catch (err) {
      return {
        ok: false,
        status: 'error',
        output: [],
        requiresApproval: null,
        requiresInput: null,
        error: {
          type: 'runtime_error',
          message: err?.message ?? String(err),
        },
      };
    }
  }

  clone() {
    const cloned = new Lobster(this.#options);
    cloned.#stages = [...this.#stages];
    cloned.#meta = this.#meta ? { ...this.#meta } : null;
    return cloned;
  }
}

function decodeSdkResumePayload(token: string): SdkResumePayload {
  const payload = decodeToken(token);
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid token');
  }
  const data = payload as Record<string, unknown>;
  if (data.protocolVersion !== 1 || data.v !== 1) {
    throw new Error('Invalid token');
  }
  if (typeof data.resumeAtIndex !== 'number' || !Number.isInteger(data.resumeAtIndex) || data.resumeAtIndex < 0) {
    throw new Error('Invalid token');
  }
  if (data.items !== undefined && !Array.isArray(data.items)) {
    throw new Error('Invalid token');
  }
  return data as unknown as SdkResumePayload;
}
