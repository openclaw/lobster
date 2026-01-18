import { execCommand } from './stdlib/exec.js';
import { headCommand } from './stdlib/head.js';
import { jsonCommand } from './stdlib/json.js';
import { pickCommand } from './stdlib/pick.js';
import { tableCommand } from './stdlib/table.js';
import { whereCommand } from './stdlib/where.js';
import { approveCommand } from './stdlib/approve.js';
import { gogGmailSearchCommand } from './stdlib/gog_gmail_search.js';
import { gogGmailSendCommand } from './stdlib/gog_gmail_send.js';
import { emailTriageCommand } from './stdlib/email_triage.js';
import { clawdInvokeCommand } from './stdlib/clawd_invoke.js';

export function createDefaultRegistry() {
  const commands = new Map();

  for (const cmd of [
    execCommand,
    headCommand,
    jsonCommand,
    pickCommand,
    tableCommand,
    whereCommand,
    approveCommand,
    gogGmailSearchCommand,
    gogGmailSendCommand,
    emailTriageCommand,
    clawdInvokeCommand,
  ]) {
    commands.set(cmd.name, cmd);
  }

  return {
    get(name) {
      return commands.get(name);
    },
    list() {
      return [...commands.keys()].sort();
    },
  };
}
