type EmailLike = {
  id?: string;
  threadId?: string;
  from?: string;
  subject?: string;
  date?: string;
  snippet?: string;
  labels?: string[];
};

function normalizeEmail(raw: any): Required<Pick<EmailLike, "id" | "threadId" | "from" | "subject" | "date" | "snippet">> & {
  labels: string[];
} {
  const id = String(raw?.id ?? raw?.messageId ?? "").trim();
  const threadId = String(raw?.threadId ?? raw?.thread_id ?? id).trim();
  const from = String(raw?.from ?? raw?.sender ?? "").trim();
  const subject = String(raw?.subject ?? "").trim();
  const date = String(raw?.date ?? raw?.internalDate ?? raw?.timestamp ?? "").trim();
  const snippet = String(raw?.snippet ?? raw?.bodyPreview ?? "").trim();
  const labels = Array.isArray(raw?.labels) ? raw.labels.map((x: any) => String(x)) : [];

  return {
    id,
    threadId: threadId || id,
    from,
    subject,
    date,
    snippet,
    labels,
  };
}

function isLikelyNoReply(from: string) {
  const f = from.toLowerCase();
  return (
    f.includes("no-reply") ||
    f.includes("noreply") ||
    f.includes("do-not-reply") ||
    f.includes("donotreply")
  );
}

export const emailTriageCommand = {
  name: "email.triage",
  meta: {
    description: "Deterministic bucketing + summary for email messages",
    argsSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum items to consume from input stream", default: 20 },
        _: { type: "array", items: { type: "string" } },
      },
      required: [],
    },
    sideEffects: [],
  },
  help() {
    return (
      `email.triage — deterministic bucketing + summary for email messages\n\n` +
      `Usage:\n` +
      `  gog.gmail.search --query 'newer_than:1d' --max 20 | email.triage\n\n` +
      `Output:\n` +
      `  Single object: { summary, buckets, emails }\n\n` +
      `Notes:\n` +
      `  - Read-only: does not send anything.\n` +
      `  - Combine with an agent step to draft replies, then approve + gog.gmail.send.\n`
    );
  },
  async run({ input, args }) {
    const limit = Number(args.limit ?? 20);

    const emails: ReturnType<typeof normalizeEmail>[] = [];
    for await (const item of input) {
      emails.push(normalizeEmail(item));
      if (emails.length >= limit) break;
    }

    const buckets = {
      needsReply: [] as any[],
      needsAction: [] as any[],
      fyi: [] as any[],
    };

    for (const e of emails) {
      const subjLower = e.subject.toLowerCase();
      const unread = e.labels.some((l) => l.toUpperCase() === "UNREAD");

      if (subjLower.includes("action required") || subjLower.includes("urgent")) {
        buckets.needsAction.push(e);
        continue;
      }

      if (unread && !isLikelyNoReply(e.from)) {
        buckets.needsReply.push(e);
        continue;
      }

      buckets.fyi.push(e);
    }

    const summary = `${buckets.needsReply.length} need replies, ${buckets.needsAction.length} need action, ${buckets.fyi.length} FYI`;

    return {
      output: (async function* () {
        yield {
          summary,
          buckets: {
            needsReply: buckets.needsReply.map((x) => x.id),
            needsAction: buckets.needsAction.map((x) => x.id),
            fyi: buckets.fyi.map((x) => x.id),
          },
          emails,
        };
      })(),
    };
  },
};
