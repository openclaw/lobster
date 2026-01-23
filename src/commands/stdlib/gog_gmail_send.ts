import { spawn } from "node:child_process";

function run(cmd: string, argv: string[], env: Record<string, string | undefined>, cwd?: string) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(cmd, argv, {
      env: { ...process.env, ...env },
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += String(d)));
    child.stderr?.on("data", (d) => (stderr += String(d)));

    child.on("error", (err: any) => {
      if (err?.code === "ENOENT") {
        reject(new Error("gog not found on PATH (install: https://github.com/steipete/gog)"));
        return;
      }
      reject(err);
    });

    child.on("close", (code) => {
      resolve({ stdout, stderr, code });
    });
  });
}

type Draft = {
  to: string;
  subject: string;
  body: string;
};

function parseDraft(item: any): Draft {
  if (!item || typeof item !== "object") {
    throw new Error("gog.gmail.send expects draft objects");
  }
  const to = String((item as any).to ?? "").trim();
  const subject = String((item as any).subject ?? "").trim();
  const body = String((item as any).body ?? "").trim();
  if (!to) throw new Error("gog.gmail.send draft missing to");
  return { to, subject, body };
}

export const gogGmailSendCommand = {
  name: "gog.gmail.send",
  meta: {
    description: "Send Gmail messages via gog",
    argsSchema: {
      type: "object",
      properties: {
        dryRun: { type: "boolean", description: "If true, do not send; echo drafts" },
        "dry-run": { type: "boolean", description: "Alias for dryRun" },
        _: { type: "array", items: { type: "string" } },
      },
      required: [],
    },
    sideEffects: ['sends_email'],
  },
  help() {
    return (
      `gog.gmail.send — send Gmail messages via gog\n\n` +
      `Usage:\n` +
      `  ... | approve --prompt 'Send replies?' | gog.gmail.send\n\n` +
      `Input:\n` +
      `  Stream of draft objects: { to, subject, body }\n\n` +
      `Notes:\n` +
      `  - Requires the gog CLI: https://github.com/steipete/gog\n` +
      `  - Set GOG_BIN to override the executable used (default: gog).\n`
    );
  },
  async run({ input, args, ctx }) {
    const dryRun = Boolean(args.dryRun ?? args["dry-run"] ?? false);
    const gogBinRaw = String(ctx.env.GOG_BIN ?? "gog");
    const isScript = /\.(mjs|cjs|js|ts)$/i.test(gogBinRaw);
    const gogBin = isScript ? process.execPath : gogBinRaw;

    const results: any[] = [];

    for await (const item of input) {
      const draft = parseDraft(item);

      if (dryRun) {
        results.push({ ok: true, dryRun: true, ...draft });
        continue;
      }

      const argvBase = [
        "gmail",
        "send",
        "--to",
        draft.to,
        ...(draft.subject ? ["--subject", draft.subject] : []),
        ...(draft.body ? ["--body", draft.body] : []),
        "--json",
      ];

      const argv = isScript ? [gogBinRaw, ...argvBase] : argvBase;
      const res = await run(gogBin, argv, ctx.env, process.cwd());
      if (res.code !== 0) {
        throw new Error(`gog.gmail.send failed (${res.code ?? "?"}): ${res.stderr.slice(0, 400)}`);
      }

      let parsed: any;
      try {
        parsed = res.stdout ? JSON.parse(res.stdout) : { ok: true };
      } catch (_err) {
        parsed = { ok: true, raw: res.stdout };
      }

      results.push(parsed);
    }

    return {
      output: (async function* () {
        for (const r of results) yield r;
      })(),
    };
  },
};
