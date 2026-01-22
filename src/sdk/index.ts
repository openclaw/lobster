/**
 * Lobster SDK - Workflow runtime for AI agents
 *
 * @example
 * import { Lobster, approve, exec } from 'lobster-sdk';
 *
 * const workflow = new Lobster()
 *   .pipe(exec('gh pr view 123 --repo owner/repo --json title,url'))
 *   .pipe(items => items.filter(e => e.unread))
 *   .pipe(approve({ prompt: 'Process these emails?' }))
 *   .pipe(async function* (items) {
 *     for (const item of items) {
 *       yield { ...item, processed: true };
 *     }
 *   });
 *
 * const result = await workflow.run();
 */

export { Lobster } from './Lobster.js';
export { approve } from './primitives/approve.js';
export { exec } from './primitives/exec.js';
export { stateGet, stateSet, state } from './primitives/state.js';
export { diffLast } from './primitives/diff.js';
export { runPipeline } from './runtime.js';
