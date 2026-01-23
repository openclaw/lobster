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

export const gogGmailSearchCommand = {
  name: "gog.gmail.search",
  meta: {
    description: "Fetch Gmail threads via gog (JSON)",
    argsSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Gmail search query", default: "newer_than:1d" },
        max: { type: "number", description: "Max results", default: 20 },
        limit: { type: "number", description: "Alias for max" },
        _: { type: "array", items: { type: "string" } },
      },
      required: [],
    },
    sideEffects: ['reads_email'],
  },
  help() {
    return (
      `gog.gmail.search — fetch Gmail messages via gog (JSON)\n\n` +
      `Usage:\n` +
      `  gog.gmail.search --query 'newer_than:1d' --max 20\n\n` +
      `Notes:\n` +
      `  - Requires the gog CLI: https://github.com/steipete/gog\n` +
      `  - Set GOG_BIN to override the executable used (default: gog).\n` +
      `  - This command outputs an array of message objects (as a stream).\n`
    );
  },
  async run({ input, args, ctx }) {
    // Drain input
    for await (const _item of input) {
      // no-op
    }

    const query = String(args.query ?? "newer_than:1d");
    const max = Number(args.max ?? args.limit ?? 20);

    const gogBinRaw = String(ctx.env.GOG_BIN ?? "gog");

    // gog CLI (v0.9.x) expects the query as a positional argument:
    //   gog gmail search <query> ... --json
    // Earlier draft versions used --query; keep Lobster's --query flag but translate it.
    const argvBase = ["gmail", "search", query, "--json", "--max", String(max)];

    // Test-friendly: allow pointing GOG_BIN at a node script.
    const isScript = /\.(mjs|cjs|js|ts)$/i.test(gogBinRaw);
    const gogBin = isScript ? process.execPath : gogBinRaw;
    const argv = isScript ? [gogBinRaw, ...argvBase] : argvBase;

    const res = await run(gogBin, argv, ctx.env, process.cwd());
    if (res.code !== 0) {
      throw new Error(`gog.gmail.search failed (${res.code ?? "?"}): ${res.stderr.slice(0, 400)}`);
    }

    let parsed: any;
    try {
      parsed = JSON.parse(res.stdout);
    } catch (_err) {
      throw new Error("gog.gmail.search expected JSON output");
    }

    // gog gmail search --json returns either:
    // - an array of message/thread objects (older versions / some commands), or
    // - an object like { nextPageToken, threads: [...] } (gog v0.9.x).
    const items = Array.isArray(parsed)
      ? // Some gog versions return: [ { nextPageToken, threads: [...] } ]
        (parsed as any[]).flatMap((x) => (Array.isArray(x?.threads) ? x.threads : [x]))
      : Array.isArray((parsed as any)?.threads)
        ? (parsed as any).threads
        : [parsed];

    return {
      output: (async function* () {
        for (const item of items) yield item;
      })(),
    };
  },
};
