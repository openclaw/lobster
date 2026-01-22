#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const argv = process.argv.slice(2);

// Minimal mock for `gog gmail search` and `gog gmail send`.
if (argv[0] === 'gmail' && argv[1] === 'search') {
  const data = readFileSync(join(__dirname, 'gog_gmail_search.json'), 'utf8');
  process.stdout.write(data);
  process.exit(0);
}

if (argv[0] === 'gmail' && argv[1] === 'send') {
  // Echo a json success object.
  process.stdout.write(JSON.stringify({ ok: true }));
  process.exit(0);
}

process.stderr.write('mock-gog: unsupported args: ' + argv.join(' ') + '\n');
process.exit(2);
