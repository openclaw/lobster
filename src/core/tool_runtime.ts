import { Writable } from "node:stream";
import path from "node:path";

import { createDefaultRegistry } from "../commands/registry.js";
import { parsePipeline } from "../parser.js";
import { decodeResumeToken, kindFromStateKey } from "../resume.js";
import { runPipeline } from "../runtime.js";
import { encodeToken } from "../token.js";
import {
  deleteStateJson,
  deleteApprovalId,
  findStateKeyByApprovalId,
  cleanupApprovalIndexByStateKey,
} from "../state/store.js";
import { WorkflowResumeArgumentError, runWorkflowFile } from "../workflows/file.js";
import {
  finalizePipelineToolRun,
  loadPipelineResumeState,
  validatePipelineInputResponse,
} from "../pipeline_resume_state.js";

type ToolRunContext = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  mode?: "tool" | "human" | "sdk";
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  signal?: AbortSignal;
  registry?: any;
  llmAdapters?: Record<string, any>;
};

type ToolEnvelope = {
  protocolVersion: 1;
  ok: boolean;
  status?: "ok" | "needs_approval" | "needs_input" | "cancelled";
  output?: unknown[];
  requiresApproval?: {
    type?: "approval_request";
    prompt: string;
    items: unknown[];
    preview?: string;
    resumeToken?: string;
    approvalId?: string;
  } | null;
  requiresInput?: {
    type?: "input_request";
    prompt: string;
    responseSchema: unknown;
    defaults?: unknown;
    subject?: unknown;
    resumeToken?: string;
  } | null;
  error?: {
    type: string;
    message: string;
  };
};

export async function runToolRequest({
  pipeline,
  filePath,
  args,
  ctx = {},
}: {
  pipeline?: string;
  filePath?: string;
  args?: Record<string, unknown>;
  ctx?: ToolRunContext;
}): Promise<ToolEnvelope> {
  const runtime = createToolContext(ctx);
  const hasPipeline = typeof pipeline === "string" && pipeline.trim().length > 0;
  const hasFile = typeof filePath === "string" && filePath.trim().length > 0;

  if (!hasPipeline && !hasFile) {
    return errorEnvelope("parse_error", "run requires either pipeline or filePath");
  }
  if (hasPipeline && hasFile) {
    return errorEnvelope("parse_error", "run accepts either pipeline or filePath, not both");
  }

  if (hasFile) {
    let resolvedFilePath: string;
    try {
      resolvedFilePath = await resolveWorkflowFile(filePath!, runtime.cwd);
    } catch (err: any) {
      return errorEnvelope("parse_error", err?.message ?? String(err));
    }

    try {
      const output = await runWorkflowFile({
        filePath: resolvedFilePath,
        args,
        ctx: runtime,
      });

      if (output.status === "needs_approval") {
        return okEnvelope("needs_approval", [], output.requiresApproval ?? null, null);
      }
      if (output.status === "needs_input") {
        return okEnvelope("needs_input", [], null, output.requiresInput ?? null);
      }
      if (output.status === "cancelled") {
        return okEnvelope("cancelled", [], null, null);
      }
      return okEnvelope("ok", output.output, null, null);
    } catch (err: any) {
      return errorEnvelope("runtime_error", err?.message ?? String(err));
    }
  }

  let parsed;
  try {
    parsed = parsePipeline(String(pipeline));
  } catch (err: any) {
    return errorEnvelope("parse_error", err?.message ?? String(err));
  }

  try {
    const output = await runPipeline({
      pipeline: parsed,
      registry: runtime.registry,
      input: [],
      stdin: runtime.stdin,
      stdout: runtime.stdout,
      stderr: runtime.stderr,
      env: runtime.env,
      mode: "tool",
      cwd: runtime.cwd,
      llmAdapters: runtime.llmAdapters,
      signal: runtime.signal,
    });

    const finalized = await finalizePipelineToolRun({
      env: runtime.env,
      pipeline: parsed,
      output,
    });
    return okEnvelope(
      finalized.status,
      finalized.output,
      finalized.requiresApproval,
      finalized.requiresInput,
    );
  } catch (err: any) {
    return errorEnvelope("runtime_error", err?.message ?? String(err));
  }
}

export async function resumeToolRequest({
  token,
  approvalId,
  approved,
  response,
  cancel,
  ctx = {},
}: {
  token?: string;
  approvalId?: string;
  approved?: boolean;
  response?: unknown;
  cancel?: boolean;
  ctx?: ToolRunContext;
}): Promise<ToolEnvelope> {
  const runtime = createToolContext(ctx);
  let payload: any;
  let resolvedApprovalId = approvalId ?? null;

  try {
    // Resolve short approval ID to token if provided
    let resolvedToken: string;
    if (approvalId) {
      const stateKey = await findStateKeyByApprovalId({ env: runtime.env, approvalId });
      if (!stateKey) {
        return errorEnvelope("parse_error", `Approval ID "${approvalId}" not found or expired`);
      }
      const kind = kindFromStateKey(stateKey);
      resolvedToken = encodeToken({
        protocolVersion: 1,
        v: 1,
        kind,
        stateKey,
      });
    } else if (token) {
      resolvedToken = token;
    } else {
      return errorEnvelope("parse_error", "resume requires token or approvalId");
    }
    payload = decodeResumeToken(resolvedToken);
  } catch (err: any) {
    return errorEnvelope("parse_error", err?.message ?? String(err));
  }

  // Helper: clean up approval ID index after successful use
  const cleanupIndex = async () => {
    if (resolvedApprovalId) {
      await deleteApprovalId({ env: runtime.env, approvalId: resolvedApprovalId });
    } else if (payload?.stateKey) {
      await cleanupApprovalIndexByStateKey({ env: runtime.env, stateKey: payload.stateKey });
    }
  };

  if (cancel === true) {
    await cleanupIndex();
    if (payload.kind === "workflow-file" && payload.stateKey) {
      await deleteStateJson({ env: runtime.env, key: payload.stateKey });
    }
    if (payload.kind === "pipeline-resume" && payload.stateKey) {
      await deleteStateJson({ env: runtime.env, key: payload.stateKey });
    }
    return okEnvelope("cancelled", [], null, null);
  }

  if (payload.kind === "workflow-file") {
    try {
      const output = await runWorkflowFile({
        filePath: payload.filePath,
        ctx: runtime,
        resume: payload,
        approved,
        response,
        cancel,
      });

      if (output.status === "needs_approval") {
        // Don't clean up index — next gate will issue a new approvalId
        return okEnvelope("needs_approval", [], output.requiresApproval ?? null, null);
      }
      if (output.status === "needs_input") {
        return okEnvelope("needs_input", [], null, output.requiresInput ?? null);
      }
      await cleanupIndex();
      if (output.status === "cancelled") {
        return okEnvelope("cancelled", [], null, null);
      }
      return okEnvelope("ok", output.output, null, null);
    } catch (err: any) {
      if (err instanceof WorkflowResumeArgumentError) {
        return errorEnvelope("parse_error", err.message);
      }
      // Don't clean up index on error — allow retry by --id
      return errorEnvelope("runtime_error", err?.message ?? String(err));
    }
  }

  let resumeState;
  try {
    resumeState = await loadPipelineResumeState(runtime.env, payload.stateKey);
  } catch (err: any) {
    return errorEnvelope("runtime_error", err?.message ?? String(err));
  }

  if (resumeState.haltType === "input_request") {
    if (approved !== undefined) {
      return errorEnvelope("parse_error", "pipeline input resumes require response");
    }
    if (response === undefined) {
      return errorEnvelope("parse_error", "pipeline input resumes require response");
    }
    try {
      validatePipelineInputResponse(resumeState.inputSchema, response);
    } catch (err: any) {
      return errorEnvelope("parse_error", err?.message ?? String(err));
    }
  } else {
    if (response !== undefined) {
      return errorEnvelope(
        "parse_error",
        "approval resumes require approved=true|false, not response",
      );
    }
    if (approved !== true) {
      await cleanupIndex();
      await deleteStateJson({ env: runtime.env, key: payload.stateKey });
      return okEnvelope("cancelled", [], null, null);
    }
  }

  const remaining = resumeState.pipeline.slice(resumeState.resumeAtIndex);
  const input = streamFromItems(
    resumeState.haltType === "input_request" ? [response] : resumeState.items,
  );

  try {
    const output = await runPipeline({
      pipeline: remaining,
      registry: runtime.registry,
      stdin: runtime.stdin,
      stdout: runtime.stdout,
      stderr: runtime.stderr,
      env: runtime.env,
      mode: "tool",
      cwd: runtime.cwd,
      llmAdapters: runtime.llmAdapters,
      signal: runtime.signal,
      input,
    });

    await cleanupIndex();
    const finalized = await finalizePipelineToolRun({
      env: runtime.env,
      pipeline: remaining,
      output,
      previousStateKey: payload.stateKey,
    });
    return okEnvelope(
      finalized.status,
      finalized.output,
      finalized.requiresApproval,
      finalized.requiresInput,
    );
  } catch (err: any) {
    // Don't clean up index on error — allow retry by --id
    return errorEnvelope("runtime_error", err?.message ?? String(err));
  }
}

export function createToolContext(ctx: ToolRunContext = {}) {
  return {
    cwd: ctx.cwd ?? process.cwd(),
    env: { ...process.env, ...ctx.env },
    mode: "tool" as const,
    stdin: ctx.stdin ?? process.stdin,
    stdout: ctx.stdout ?? createCaptureStream(),
    stderr: ctx.stderr ?? createCaptureStream(),
    signal: ctx.signal,
    registry: ctx.registry ?? createDefaultRegistry(),
    llmAdapters: ctx.llmAdapters,
  };
}

export function createCaptureStream() {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

function okEnvelope(
  status: "ok" | "needs_approval" | "needs_input" | "cancelled",
  output: unknown[],
  requiresApproval: ToolEnvelope["requiresApproval"],
  requiresInput: ToolEnvelope["requiresInput"],
) {
  return {
    protocolVersion: 1 as const,
    ok: true,
    status,
    output,
    requiresApproval,
    requiresInput,
  };
}

function errorEnvelope(type: string, message: string): ToolEnvelope {
  return {
    protocolVersion: 1,
    ok: false,
    error: { type, message },
  };
}

function streamFromItems(items: unknown[]) {
  return (async function* () {
    for (const item of items) {
      yield item;
    }
  })();
}

async function resolveWorkflowFile(candidate: string, cwd: string) {
  const { stat } = await import("node:fs/promises");
  const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
  const fileStat = await stat(resolved);
  if (!fileStat.isFile()) throw new Error("Workflow path is not a file");
  const ext = path.extname(resolved).toLowerCase();
  if (![".lobster", ".yaml", ".yml", ".json"].includes(ext)) {
    throw new Error("Workflow file must end in .lobster, .yaml, .yml, or .json");
  }
  return resolved;
}
