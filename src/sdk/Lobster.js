import { runPipelineInternal } from './runtime.js';
import { encodeToken, decodeToken } from './token.js';

/**
 * @typedef {Object} LobsterResult
 * @property {boolean} ok - Whether the workflow completed successfully
 * @property {'ok' | 'needs_approval' | 'cancelled' | 'error'} status - Workflow status
 * @property {any[]} output - Output items from the workflow
 * @property {Object|null} requiresApproval - Approval request if halted
 * @property {string} [requiresApproval.prompt] - Approval prompt
 * @property {any[]} [requiresApproval.items] - Items pending approval
 * @property {string} [requiresApproval.resumeToken] - Token to resume workflow
 * @property {Object} [error] - Error details if failed
 */

/**
 * @typedef {Object} LobsterOptions
 * @property {Object} [env] - Environment variables
 * @property {string} [stateDir] - State directory override
 */

/**
 * Lobster - Fluent workflow builder for AI agents
 *
 * @example
 * const workflow = new Lobster()
 *   .pipe(exec('gh pr view 123 --repo owner/repo --json title,url'))
 *   .pipe(approve({ prompt: 'Continue?' }))
 *   .run();
 */
export class Lobster {
  /** @type {Array<Function|Object>} */
  #stages = [];

  /** @type {LobsterOptions} */
  #options = {};

  /** @type {Object|null} */
  #meta = null;

  /**
   * Create a new Lobster workflow builder
   * @param {LobsterOptions} [options]
   */
  constructor(options = {}) {
    this.#options = {
      env: options.env ?? process.env,
      stateDir: options.stateDir,
    };
  }

  /**
   * Add a stage to the pipeline
   *
   * Stages can be:
   * - A function: (items: any[]) => any[] | AsyncIterable
   * - An async generator function: async function* (input) { ... }
   * - A stage object with { run: Function }
   * - A primitive from lobster-sdk (approve, exec, etc.)
   *
   * @param {Function|Object} stage - Stage to add
   * @returns {Lobster} - Returns this for chaining
   *
   * @example
   * new Lobster()
   *   .pipe(exec('gh pr view 123 --repo owner/repo --json title,url'))
   *   .pipe(items => items)
   *   .pipe(approve({ prompt: 'Proceed?' }))
   */
  pipe(stage) {
    if (typeof stage !== 'function' && typeof stage?.run !== 'function') {
      throw new Error('Stage must be a function or have a run() method');
    }
    this.#stages.push(stage);
    return this;
  }

  /**
   * Set metadata for this workflow (for recipe discovery)
   * @param {Object} meta
   * @param {string} meta.name - Workflow name
   * @param {string} meta.description - Description
   * @param {string[]} [meta.requires] - Required CLI tools
   * @param {Object} [meta.args] - Argument schema
   * @returns {Lobster}
   */
  meta(meta) {
    this.#meta = meta;
    return this;
  }

  /**
   * Get workflow metadata
   * @returns {Object|null}
   */
  getMeta() {
    return this.#meta;
  }

  /**
   * Execute the workflow
   * @param {any[]} [initialInput] - Optional initial input items
   * @returns {Promise<LobsterResult>}
   */
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

      // Check for approval halt
      if (result.halted && result.items.length === 1 && result.items[0]?.type === 'approval_request') {
        const approval = result.items[0];
        const resumeToken = encodeToken({
          protocolVersion: 1,
          v: 1,
          stageIndex: result.haltedAt?.index ?? -1,
          resumeAtIndex: (result.haltedAt?.index ?? -1) + 1,
          items: approval.items,
          prompt: approval.prompt,
          // Note: We can't serialize the stages themselves, so resume requires
          // the caller to maintain the workflow reference
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
        };
      }

      return {
        ok: true,
        status: 'ok',
        output: result.items,
        requiresApproval: null,
      };
    } catch (err) {
      return {
        ok: false,
        status: 'error',
        output: [],
        requiresApproval: null,
        error: {
          type: 'runtime_error',
          message: err?.message ?? String(err),
        },
      };
    }
  }

  /**
   * Resume a halted workflow after approval
   * @param {string} token - Resume token from previous run
   * @param {Object} options
   * @param {boolean} options.approved - Whether the approval was granted
   * @returns {Promise<LobsterResult>}
   */
  async resume(token, { approved }) {
    if (!approved) {
      return {
        ok: true,
        status: 'cancelled',
        output: [],
        requiresApproval: null,
      };
    }

    const payload = decodeToken(token);
    const resumeIndex = payload.resumeAtIndex ?? 0;
    const resumeItems = payload.items ?? [];

    // Get remaining stages
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

      // Check for another approval halt
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
        };
      }

      return {
        ok: true,
        status: 'ok',
        output: result.items,
        requiresApproval: null,
      };
    } catch (err) {
      return {
        ok: false,
        status: 'error',
        output: [],
        requiresApproval: null,
        error: {
          type: 'runtime_error',
          message: err?.message ?? String(err),
        },
      };
    }
  }

  /**
   * Clone this workflow (for creating variants)
   * @returns {Lobster}
   */
  clone() {
    const cloned = new Lobster(this.#options);
    cloned.#stages = [...this.#stages];
    cloned.#meta = this.#meta ? { ...this.#meta } : null;
    return cloned;
  }
}
