/**
 * Approve primitive - Creates a hard halt point requiring human approval
 *
 * @example
 * import { Lobster, approve } from 'lobster-sdk';
 *
 * new Lobster()
 *   .pipe(fetchEmails())
 *   .pipe(approve({ prompt: 'Send these replies?' }))
 *   .pipe(sendReplies())
 */

/**
 * Create an approval stage
 *
 * @param {Object} [options]
 * @param {string} [options.prompt='Approve?'] - Prompt to show user
 * @param {boolean} [options.preview=true] - Include items in approval request
 * @returns {Object} Stage object with run method
 */
export function approve(options = {}) {
  const prompt = options.prompt ?? 'Approve?';
  const preview = options.preview !== false;

  return {
    type: 'approve',
    prompt,

    async run({ input, ctx }) {
      // Collect all items
      const items = [];
      for await (const item of input) {
        items.push(item);
      }

      // In SDK mode, always emit approval request and halt
      return {
        halt: true,
        output: (async function* () {
          yield {
            type: 'approval_request',
            prompt,
            items: preview ? items : [],
            itemCount: items.length,
          };
        })(),
      };
    },
  };
}
