import test from "node:test";
import assert from "node:assert/strict";

import { resolveInlineShellCommand } from "../src/shell.js";

test("resolveInlineShellCommand uses POSIX shell by default", () => {
  const resolved = resolveInlineShellCommand({
    command: "echo hello",
    env: { SHELL: "/bin/zsh" },
    platform: "darwin",
  });

  assert.equal(resolved.command, "/bin/sh");
  assert.deepEqual(resolved.argv, ["-lc", "echo hello"]);
});

test("resolveInlineShellCommand uses cmd on Windows", () => {
  const resolved = resolveInlineShellCommand({
    command: "echo hello",
    env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    platform: "win32",
  });

  assert.equal(resolved.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(resolved.argv, ["/d", "/s", "/c", "echo hello"]);
});

test("resolveInlineShellCommand respects powershell override", () => {
  const resolved = resolveInlineShellCommand({
    command: "Write-Host hello",
    env: { LOBSTER_SHELL: "pwsh" },
    platform: "linux",
  });

  assert.equal(resolved.command, "pwsh");
  assert.deepEqual(resolved.argv, ["-NoProfile", "-Command", "Write-Host hello"]);
});
