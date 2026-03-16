#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

function shellQuote(arg) {
  if (/^[A-Za-z0-9_\-./:=@]+$/.test(arg)) return arg;
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

const argv = process.argv.slice(2);
const pipeline = ['clawd.invoke', ...argv.map(shellQuote)].join(' ');

const res = spawnSync('lobster', [pipeline], {
  stdio: 'inherit',
  env: process.env,
});

process.exit(res.status ?? 1);
