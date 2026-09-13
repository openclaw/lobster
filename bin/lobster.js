#!/usr/bin/env node

import { runCli } from "../dist/src/cli.js";

await runCli(process.argv.slice(2));
