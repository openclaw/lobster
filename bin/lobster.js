#!/usr/bin/env node

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function load() {
  const distEntry = join(__dirname, "../dist/src/cli.js");
  if (existsSync(distEntry)) {
    return import(pathToFileURL(distEntry).href);
  }
  const srcEntry = join(__dirname, "../src/cli.js");
  return import(pathToFileURL(srcEntry).href);
}

const mod = await load();
if (typeof mod.runCli !== "function") {
  throw new Error("lobster CLI entrypoint missing runCli()");
}

await mod.runCli(process.argv.slice(2));
