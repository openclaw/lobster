function isWhitespace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function splitPipes(input) {
  const parts = [];
  let current = '';
  let quote = null;
  let braceDepth = 0;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (quote) {
      if (ch === '\\') {
        const next = input[i + 1];
        if (next) {
          current += ch + next;
          i++;
          continue;
        }
      }
      current += ch;
      if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === '{') {
      braceDepth++;
      current += ch;
      continue;
    }

    if (ch === '}') {
      if (braceDepth > 0) {
        braceDepth--;
        current += ch;
        continue;
      }
      // braceDepth === 0: treat as literal character (backward compat)
      current += ch;
      continue;
    }

    if (ch === '|' && braceDepth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }

    current += ch;
  }

  if (quote) throw new Error('Unclosed quote');
  if (current.trim().length > 0) parts.push(current.trim());
  return parts;
}

function tokenizeCommand(input) {
  const tokens = [];
  let current = '';
  let quote = null;

  const push = () => {
    if (current.length > 0) tokens.push(current);
    current = '';
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (quote) {
      if (ch === '\\') {
        const next = input[i + 1];
        if (next) {
          current += next;
          i++;
          continue;
        }
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (isWhitespace(ch)) {
      push();
      continue;
    }

    current += ch;
  }

  if (quote) throw new Error('Unclosed quote');
  push();
  return tokens;
}

function parseArgs(tokens) {
  const args: Record<string, any> = { _: [] };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      if (eq !== -1) {
        const key = tok.slice(2, eq);
        const value = tok.slice(eq + 1);
        args[key] = value;
        continue;
      }

      const key = tok.slice(2);
      const next = tokens[i + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true;
        continue;
      }
      args[key] = next;
      i++;
      continue;
    }

    args._.push(tok);
  }

  return args;
}

/** Find the first lone `{` that is not inside quotes or a `{{...}}` template. Returns index or -1. */
function findUnquotedBrace(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && text[i + 1]) { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{') {
      if (text[i + 1] === '{') {
        // Skip past the {{ ... }} template expression
        const close = text.indexOf('}}', i + 2);
        i = close !== -1 ? close + 1 : i + 1;
        continue;
      }
      return i;
    }
  }
  return -1;
}

/** Find the `}` matching the `{` at openPos, respecting quotes, nesting, and `{{...}}` templates. */
function findMatchingBrace(text, openPos) {
  let depth = 1;
  let quote = null;
  for (let i = openPos + 1; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && text[i + 1]) { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{') {
      if (text[i + 1] === '{') {
        const close = text.indexOf('}}', i + 2);
        i = close !== -1 ? close + 1 : i + 1;
        continue;
      }
      depth++;
      continue;
    }
    if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

const MAX_PIPELINE_DEPTH = 50;

export function parsePipeline(input, _depth = 0) {
  if (_depth > MAX_PIPELINE_DEPTH) {
    throw new Error(`Pipeline nesting exceeds maximum depth of ${MAX_PIPELINE_DEPTH}`);
  }
  const stages = splitPipes(input);
  if (stages.length === 0) throw new Error('Empty pipeline');

  return stages.map((stage) => {
    const braceStart = findUnquotedBrace(stage);
    if (braceStart === -1) {
      // No brace syntax -- normal parse
      const tokens = tokenizeCommand(stage);
      if (tokens.length === 0) throw new Error('Empty command stage');
      const name = tokens[0];
      const args = parseArgs(tokens.slice(1));
      return { name, args, raw: stage };
    }

    // Brace syntax: extract prefix, body, suffix
    const prefix = stage.slice(0, braceStart);
    const braceEnd = findMatchingBrace(stage, braceStart);
    if (braceEnd === -1) throw new Error('Unclosed brace');

    const bodyRaw = stage.slice(braceStart + 1, braceEnd).trim();
    if (!bodyRaw) throw new Error('Empty body in { } block');

    const suffix = stage.slice(braceEnd + 1).trim();
    const preview = suffix.length > 50 ? suffix.slice(0, 50) + '...' : suffix;
    if (suffix) throw new Error(`Unexpected content after closing brace: ${preview}`);

    const prefixTokens = tokenizeCommand(prefix);
    if (prefixTokens.length === 0) throw new Error('Empty command before { }');
    const name = prefixTokens[0];
    const args = parseArgs(prefixTokens.slice(1));

    // Recursively parse the sub-pipeline body
    args._body = parsePipeline(bodyRaw, _depth + 1);
    args._bodyRaw = bodyRaw;

    return { name, args, raw: stage };
  });
}
