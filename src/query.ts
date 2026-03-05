import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { defaultStateDir } from './state/store.js';
import { encodeToken } from './token.js';

/**
 * @typedef {Object} RunSummary
 * @property {string} id
 * @property {string} filePath
 * @property {string} workflowName
 * @property {'halted'} status
 * @property {string} createdAt
 * @property {string} approvalStepId
 * @property {string|null} approvalPrompt
 * @property {number} resumeAtIndex
 * @property {string[]} completedSteps
 */

/**
 * @typedef {RunSummary & { args: Record<string, unknown>, steps: Record<string, unknown>, resumeToken: string }} RunDetail
 */

function extractApprovalPrompt(state) {
  const stepId = state.approvalStepId;
  if (!stepId || !state.steps?.[stepId]) return null;
  const stepResult = state.steps[stepId];
  if (stepResult.json?.prompt) return stepResult.json.prompt;
  if (stepResult.json?.requiresApproval?.prompt) return stepResult.json.requiresApproval.prompt;
  return null;
}

function stateToSummary(id, state) {
  const completedSteps = state.steps
    ? Object.keys(state.steps).filter((k) => !state.steps[k]?.skipped)
    : [];

  return {
    id,
    filePath: state.filePath ?? 'unknown',
    workflowName: state.filePath
      ? path.basename(state.filePath, path.extname(state.filePath))
      : 'unknown',
    status: 'halted',
    createdAt: state.createdAt ?? new Date(0).toISOString(),
    approvalStepId: state.approvalStepId ?? 'unknown',
    approvalPrompt: extractApprovalPrompt(state),
    resumeAtIndex: state.resumeAtIndex ?? 0,
    completedSteps,
  };
}

export async function listRuns(env) {
  const stateDir = defaultStateDir(env);
  let files;
  try {
    files = await fsp.readdir(stateDir);
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }

  const resumeFiles = files.filter(
    (f) => f.startsWith('workflow_resume_') && f.endsWith('.json')
  );
  const results = [];

  for (const file of resumeFiles) {
    try {
      const text = await fsp.readFile(path.join(stateDir, file), 'utf8');
      const state = JSON.parse(text);
      const id = file.replace('workflow_resume_', '').replace('.json', '');
      results.push(stateToSummary(id, state));
    } catch {
      // Skip corrupt files silently
    }
  }

  results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return results;
}

export async function getRunDetail(id, env) {
  const stateDir = defaultStateDir(env);
  const filePath = path.join(stateDir, `workflow_resume_${id}.json`);
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    const state = JSON.parse(text);
    const summary = stateToSummary(id, state);
    return {
      ...summary,
      args: state.args ?? {},
      steps: state.steps ?? {},
      resumeToken: encodeToken({
        filePath: state.filePath,
        resumeAtIndex: state.resumeAtIndex,
        steps: state.steps,
        args: state.args,
        approvalStepId: state.approvalStepId,
      }),
    };
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

export async function cancelRun(id, env) {
  const stateDir = defaultStateDir(env);
  const filePath = path.join(stateDir, `workflow_resume_${id}.json`);
  try {
    await fsp.unlink(filePath);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}
