import { execFile } from "node:child_process";
import type { LobsterCommand } from "../types.js";

type AgentCliRunner = (params: {
  executable: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}) => Promise<unknown>;

export const openclawAgentCommand = createOpenClawAgentCommand();

export function createOpenClawAgentCommand(
  runCli: AgentCliRunner = runOpenClawAgentCli,
): LobsterCommand {
  return {
    name: "openclaw.agent",
    meta: {
      description: "Run a configured OpenClaw agent turn",
      argsSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Configured OpenClaw agent id" },
          prompt: { type: "string", description: "Message for the agent" },
          message: { type: "string", description: "Alias for prompt" },
          model: { type: "string", description: "OpenClaw model override for this turn" },
          sessionKey: { type: "string", description: "OpenClaw session key" },
          "session-key": { type: "string", description: "Alias for sessionKey" },
          sessionId: { type: "string", description: "OpenClaw session id" },
          "session-id": { type: "string", description: "Alias for sessionId" },
          thinking: { type: "string", description: "OpenClaw thinking level" },
          timeout: { type: "number", description: "Agent timeout in seconds" },
          local: { type: "boolean", description: "Force OpenClaw embedded execution" },
          _: { type: "array", items: { type: "string" } },
        },
        required: [],
      },
      sideEffects: ["calls_openclaw_agent"],
    },
    help() {
      return (
        `openclaw.agent — run a configured OpenClaw agent turn\n\n` +
        `Usage:\n` +
        `  openclaw.agent --agent ops --prompt "Summarize logs"\n` +
        `  openclaw.agent --agent ops --session-key incident-42 --model openai/gpt-5.4 --prompt "Continue"\n` +
        `  ... | openclaw.agent --agent ops --prompt "Review this input"\n\n` +
        `Notes:\n` +
        `  - Delegates agent, session, model, and auth behavior to the installed OpenClaw CLI.\n` +
        `  - Requires --agent, --session-key, or --session-id.\n` +
        `  - Pipeline input is appended to the message as JSONL under a labeled section.\n` +
        `  - Returns the structured OpenClaw --json response unchanged.\n`
      );
    },
    async run({ input, args, ctx }) {
      const prompt = extractPrompt(args);
      if (!prompt) {
        throw new Error("openclaw.agent requires --prompt, --message, or positional text");
      }

      const agent = optionalString(args.agent);
      const sessionKey = optionalString(args.sessionKey ?? args["session-key"]);
      const sessionId = optionalString(args.sessionId ?? args["session-id"]);
      if (!agent && !sessionKey && !sessionId) {
        throw new Error("openclaw.agent requires --agent, --session-key, or --session-id");
      }

      const inputItems: unknown[] = [];
      for await (const item of input) inputItems.push(item);

      const argv = ["agent", "--json", "--message", appendPipelineInput(prompt, inputItems)];
      pushOption(argv, "--agent", agent);
      pushOption(argv, "--model", optionalString(args.model));
      pushOption(argv, "--session-key", sessionKey);
      pushOption(argv, "--session-id", sessionId);
      pushOption(argv, "--thinking", optionalString(args.thinking));

      if (args.timeout !== undefined && args.timeout !== null) {
        const timeout = Number(args.timeout);
        if (!Number.isInteger(timeout) || timeout < 0) {
          throw new Error("openclaw.agent --timeout must be a non-negative integer in seconds");
        }
        pushOption(argv, "--timeout", String(timeout));
      }
      if (args.local === true) argv.push("--local");

      const env = (ctx?.env ?? process.env) as NodeJS.ProcessEnv;
      const executable = optionalString(env.LOBSTER_OPENCLAW_BIN) ?? "openclaw";
      const response = await runCli({
        executable,
        argv,
        cwd: ctx?.cwd ?? process.cwd(),
        env,
        signal: ctx?.signal,
      });
      return { output: streamOf([response]) };
    },
  };
}

export function runOpenClawAgentCli(params: {
  executable: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      params.executable,
      params.argv,
      {
        cwd: params.cwd,
        env: params.env,
        signal: params.signal,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          if (error.name === "AbortError") {
            reject(error);
            return;
          }
          const detail = String(stderr || stdout || error.message).trim();
          reject(new Error(`openclaw.agent failed: ${detail}`));
          return;
        }
        try {
          const parsed = JSON.parse(String(stdout).trim() || "null");
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("response must be an object");
          }
          resolve(parsed);
        } catch {
          reject(new Error("openclaw.agent expected JSON output from `openclaw agent --json`"));
        }
      },
    );
  });
}

function extractPrompt(args: Record<string, unknown>): string {
  const explicit = optionalString(args.prompt ?? args.message);
  if (explicit) return explicit;
  return Array.isArray(args._) ? args._.map(String).join(" ").trim() : "";
}

function appendPipelineInput(prompt: string, items: unknown[]): string {
  if (items.length === 0) return prompt;
  const jsonl = items.map((item) => JSON.stringify(item)).join("\n");
  return `${prompt}\n\nPipeline input (JSONL):\n${jsonl}`;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function pushOption(argv: string[], name: string, value: string | undefined): void {
  if (value !== undefined) argv.push(name, value);
}

async function* streamOf(items: unknown[]) {
  for (const item of items) yield item;
}
