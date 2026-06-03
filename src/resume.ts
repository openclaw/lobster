import { decodeToken, encodeToken } from "./token.js";
import { decodeWorkflowResumePayload } from "./workflows/file.js";
import { findStateKeyByApprovalId } from "./state/store.js";

/**
 * Determine the resume payload kind from a state key prefix.
 * State keys use naming conventions: pipeline_resume_<uuid> or workflow_resume_<uuid>.
 */
export function kindFromStateKey(stateKey: string): "pipeline-resume" | "workflow-file" {
  if (stateKey.startsWith("pipeline_resume_")) return "pipeline-resume";
  if (stateKey.startsWith("workflow_resume_")) return "workflow-file";
  // Fallback for unknown prefixes — workflow-file is the original behavior
  return "workflow-file";
}

export type PipelineResumePayload = {
  protocolVersion: 1;
  v: 1;
  kind: "pipeline-resume";
  stateKey: string;
};

export function parseResumeArgs(argv) {
  const args = { decision: null, token: null, approvalId: null, responseJson: null, cancel: false };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--token") {
      args.token = argv[i + 1];
      i++;
      continue;
    }
    if (tok.startsWith("--token=")) {
      args.token = tok.slice("--token=".length);
      continue;
    }
    if (tok === "--id") {
      args.approvalId = argv[i + 1];
      i++;
      continue;
    }
    if (tok.startsWith("--id=")) {
      args.approvalId = tok.slice("--id=".length);
      continue;
    }
    if (tok === "--response-json") {
      args.responseJson = argv[i + 1];
      i++;
      continue;
    }
    if (tok.startsWith("--response-json=")) {
      args.responseJson = tok.slice("--response-json=".length);
      continue;
    }
    if (tok === "--cancel") {
      const next = argv[i + 1];
      if (typeof next === "string" && !next.startsWith("--")) {
        const parsed = parseBooleanArg(next);
        if (parsed === null) {
          throw new Error("resume --cancel must be true or false");
        }
        args.cancel = parsed;
        i++;
        continue;
      }
      args.cancel = true;
      continue;
    }
    if (tok.startsWith("--cancel=")) {
      const parsed = parseBooleanArg(tok.slice("--cancel=".length));
      if (parsed === null) throw new Error("resume --cancel must be true or false");
      args.cancel = parsed;
      continue;
    }
    if (tok === "--approve" || tok === "--decision") {
      args.decision = argv[i + 1];
      i++;
      continue;
    }
    if (tok.startsWith("--approve=")) {
      args.decision = tok.slice("--approve=".length);
      continue;
    }
    if (tok.startsWith("--decision=")) {
      args.decision = tok.slice("--decision=".length);
      continue;
    }
  }

  if (!args.token && !args.approvalId) throw new Error("resume requires --token or --id");
  const intentCount =
    Number(Boolean(args.decision)) + Number(args.responseJson !== null) + Number(args.cancel);
  if (intentCount > 1) {
    throw new Error("resume accepts only one of --approve, --response-json, or --cancel");
  }
  if (intentCount === 0) {
    throw new Error("resume requires --approve yes|no, --response-json, or --cancel");
  }

  if (args.cancel) {
    return {
      token: args.token ? String(args.token) : null,
      approvalId: args.approvalId ? String(args.approvalId) : null,
      cancel: true,
    };
  }

  if (args.responseJson !== null) {
    try {
      return {
        token: args.token ? String(args.token) : null,
        approvalId: args.approvalId ? String(args.approvalId) : null,
        response: JSON.parse(String(args.responseJson)),
      };
    } catch {
      throw new Error("resume --response-json must be valid JSON");
    }
  }

  const decision = String(args.decision).toLowerCase();
  if (!["yes", "y", "no", "n"].includes(decision))
    throw new Error("resume --approve must be yes or no");
  return {
    token: args.token ? String(args.token) : null,
    approvalId: args.approvalId ? String(args.approvalId) : null,
    approved: decision === "yes" || decision === "y",
  };
}

function parseBooleanArg(value: string): boolean | null {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (["1", "true", "yes", "y"].includes(raw)) return true;
  if (["0", "false", "no", "n"].includes(raw)) return false;
  return null;
}

/**
 * Resolve an approval ID to a resume token by looking up the state key.
 * Detects the kind (workflow-file vs pipeline-resume) from the state key prefix.
 */
export async function resolveApprovalId(
  approvalId: string,
  env: Record<string, string | undefined>,
): Promise<string> {
  const stateKey = await findStateKeyByApprovalId({ env, approvalId });
  if (!stateKey) {
    throw new Error(`Approval ID "${approvalId}" not found or expired`);
  }

  const kind = kindFromStateKey(stateKey);

  return encodeToken({
    protocolVersion: 1,
    v: 1,
    kind,
    stateKey,
  });
}

export function decodeResumeToken(token) {
  const payload = decodeToken(token);
  if (!payload || typeof payload !== "object") throw new Error("Invalid token");
  if (payload.protocolVersion !== 1) throw new Error("Unsupported protocol version");
  if (payload.v !== 1) throw new Error("Unsupported token version");
  const workflowPayload = decodeWorkflowResumePayload(payload);
  if (workflowPayload) return workflowPayload;
  const pipelinePayload = decodePipelineResumePayload(payload);
  if (pipelinePayload) return pipelinePayload;
  throw new Error("Invalid token");
}

function decodePipelineResumePayload(payload: unknown): PipelineResumePayload | null {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as Partial<PipelineResumePayload>;
  if (data.kind !== "pipeline-resume") return null;
  if (data.protocolVersion !== 1 || data.v !== 1) throw new Error("Unsupported token version");
  if (!data.stateKey || typeof data.stateKey !== "string") throw new Error("Invalid token");
  return {
    protocolVersion: 1,
    v: 1,
    kind: "pipeline-resume",
    stateKey: data.stateKey,
  };
}
