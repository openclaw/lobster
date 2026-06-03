import fs from "node:fs/promises";
import { applyFilters } from "../../core/filters.js";

function getByPath(obj: any, path: string): any {
  if (path === "." || path === "this") return obj;
  const parts = path.split(".").filter(Boolean);
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function splitFilterChain(expr: string): string[] {
  const parts: string[] = [];
  let current = "";
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      current += ch;
      i += 1;
      while (i < expr.length && expr[i] !== quote) {
        if (expr[i] === "\\" && i + 1 < expr.length) {
          current += expr[i] + expr[i + 1];
          i += 2;
        } else {
          current += expr[i];
          i += 1;
        }
      }
      if (i < expr.length) {
        current += expr[i];
        i += 1;
      }
    } else if (ch === "|") {
      parts.push(current.trim());
      current = "";
      i += 1;
    } else {
      current += ch;
      i += 1;
    }
  }
  parts.push(current.trim());
  return parts;
}

function renderTemplate(tpl: string, ctx: any): string {
  return tpl.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, expr) => {
    const rawExpr = String(expr ?? "").trim();
    const parts = splitFilterChain(rawExpr);
    const key = parts[0];
    let val: unknown = getByPath(ctx, key);
    if (parts.length > 1) {
      val = applyFilters(val, parts.slice(1));
    }
    if (val === undefined || val === null) return "";
    if (typeof val === "string") return val;
    if (typeof val === "number" || typeof val === "boolean") return String(val);
    return JSON.stringify(val);
  });
}

export const templateCommand = {
  name: "template",
  meta: {
    description: "Render a simple {{path}} template against each input item",
    argsSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            "Template text (supports {{path}}, {{path | filter}}, {{.}} for the whole item)",
        },
        file: { type: "string", description: "Template file path" },
        _: { type: "array", items: { type: "string" } },
      },
      required: [],
    },
    sideEffects: [],
  },
  help() {
    return (
      `template — render a simple template against each item\n\n` +
      `Usage:\n` +
      `  ... | template --text 'PR {{number}}: {{title}}'\n` +
      `  ... | template --file ./draft.txt\n\n` +
      `Template syntax:\n` +
      `  - {{field}} or {{nested.field}}\n` +
      `  - {{.}} for the whole item\n` +
      `  - {{field | filter}} with pipe-based filters\n` +
      `  - Missing values render as empty string\n\n` +
      `Filters:\n` +
      `  upper, lower, trim, truncate N, replace "from" "to", split sep\n` +
      `  first, last, length, join sep\n` +
      `  json, string, default val, round N, date fmt\n`
    );
  },
  async run({ input, args }: any) {
    let tpl = typeof args.text === "string" ? args.text : undefined;
    const file = typeof args.file === "string" ? args.file : undefined;

    if (!tpl && file) {
      tpl = await fs.readFile(file, "utf8");
    }

    if (!tpl) {
      const positional = Array.isArray(args._) ? args._ : [];
      if (positional.length) tpl = positional.join(" ");
    }

    if (!tpl) throw new Error("template requires --text or --file (or positional text)");

    return {
      output: (async function* () {
        for await (const item of input) {
          yield renderTemplate(String(tpl), item);
        }
      })(),
    };
  },
};
