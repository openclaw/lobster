#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

function shellQuote(arg) {
  // Conservative POSIX-ish quoting for embedding argv into a single pipeline string.
  // Lobster's pipeline parser preserves quoted substrings.
  if (/^[A-Za-z0-9_\-./:=@]+$/.test(arg)) return arg;
  // single-quote, escaping embedded single quotes: ' -> '\''
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

const argv = process.argv.slice(2);
const pipeline = ['openclaw.invoke', ...argv.map(shellQuote)].join(' ');

const res = spawnSync('lobster', [pipeline], {
  stdio: 'inherit',
  env: process.env,
});

process.exit(res.status ?? 1);
