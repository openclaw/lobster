import { execCommand } from "./stdlib/exec.js";
import { headCommand } from "./stdlib/head.js";
import { jsonCommand } from "./stdlib/json.js";
import { pickCommand } from "./stdlib/pick.js";
import { tableCommand } from "./stdlib/table.js";
import { whereCommand } from "./stdlib/where.js";
import { approveCommand } from "./stdlib/approve.js";
import { clawdInvokeCommand } from "./stdlib/clawd_invoke.js";
import { stateGetCommand, stateSetCommand } from "./stdlib/state.js";
import { diffLastCommand } from "./stdlib/diff_last.js";
import { workflowsListCommand } from "./workflows/workflows_list.js";
import { workflowsRunCommand } from "./workflows/workflows_run.js";

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
    clawdInvokeCommand,
    stateGetCommand,
    stateSetCommand,
    diffLastCommand,
    workflowsListCommand,
    workflowsRunCommand,
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
