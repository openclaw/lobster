import { encode as encodeToon } from '@toon-format/toon';

export function createJsonRenderer(stdout) {
  return {
    json(items) {
      stdout.write(JSON.stringify(items, null, 2));
      stdout.write('\n');
    },
    lines(lines) {
      for (const line of lines) stdout.write(String(line) + '\n');
    },
  };
}

export function createToonRenderer(stdout) {
  return {
    json(items) {
      stdout.write(encodeToon(items));
      stdout.write('\n');
    },
    lines(lines) {
      for (const line of lines) stdout.write(String(line) + '\n');
    },
  };
}
