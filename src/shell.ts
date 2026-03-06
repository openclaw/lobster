/**
 * Resolve the platform shell for command execution.
 * Returns [command, args] tuple ready for spawn().
 */
export function resolveShell(command: string): [string, string[]] {
  if (process.platform === 'win32') {
    return ['cmd.exe', ['/s', '/c', command]];
  }
  return ['/bin/sh', ['-lc', command]];
}
