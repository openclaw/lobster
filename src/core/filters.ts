export type FilterFn = (value: unknown, ...args: string[]) => unknown;

const FILTERS = new Map<string, FilterFn>();

FILTERS.set('upper', (v) => String(v ?? '').toUpperCase());
FILTERS.set('lower', (v) => String(v ?? '').toLowerCase());
FILTERS.set('trim', (v) => String(v ?? '').trim());
FILTERS.set('truncate', (v, n) => {
  const s = String(v ?? '');
  const len = parseInt(n) || 80;
  return s.length > len ? s.slice(0, len) + '...' : s;
});
FILTERS.set('replace', (v, from, to) => String(v ?? '').replaceAll(from ?? '', to ?? ''));
FILTERS.set('split', (v, sep) => String(v ?? '').split(sep ?? ','));
FILTERS.set('first', (v) => (Array.isArray(v) ? v[0] : v));
FILTERS.set('last', (v) => (Array.isArray(v) ? v[v.length - 1] : v));
FILTERS.set('length', (v) => {
  if (Array.isArray(v)) return v.length;
  if (typeof v === 'string') return v.length;
  return 0;
});
FILTERS.set('join', (v, sep) => (Array.isArray(v) ? v.join(sep ?? ', ') : String(v ?? '')));
FILTERS.set('json', (v) => JSON.stringify(v, null, 2));
FILTERS.set('string', (v) => String(v ?? ''));
FILTERS.set('default', (v, def) => (v == null || v === '' ? def : v));
FILTERS.set('round', (v, n) => {
  const num = Number(v);
  const dec = parseInt(n) || 0;
  return isNaN(num) ? v : Number(num.toFixed(dec));
});
FILTERS.set('date', (v, fmt) => {
  const d = new Date(String(v));
  if (isNaN(d.getTime())) return String(v);
  if (!fmt) return d.toISOString();
  return fmt
    .replace('YYYY', String(d.getFullYear()))
    .replace('MM', String(d.getMonth() + 1).padStart(2, '0'))
    .replace('DD', String(d.getDate()).padStart(2, '0'))
    .replace('HH', String(d.getHours()).padStart(2, '0'))
    .replace('mm', String(d.getMinutes()).padStart(2, '0'))
    .replace('ss', String(d.getSeconds()).padStart(2, '0'));
});

export function getFilter(name: string): FilterFn | undefined {
  return FILTERS.get(name);
}

/**
 * Parse a single filter expression like `truncate 80` or `replace "-" "_"`.
 * Returns [filterName, ...args].
 */
export function parseFilterExpression(expr: string): [string, ...string[]] {
  const trimmed = expr.trim();
  const parts: string[] = [];
  let i = 0;

  while (i < trimmed.length) {
    // skip whitespace
    while (i < trimmed.length && trimmed[i] === ' ') i++;
    if (i >= trimmed.length) break;

    if (trimmed[i] === '"' || trimmed[i] === "'") {
      const quote = trimmed[i];
      i++;
      let arg = '';
      while (i < trimmed.length && trimmed[i] !== quote) {
        if (trimmed[i] === '\\' && i + 1 < trimmed.length) {
          arg += trimmed[i + 1];
          i += 2;
        } else {
          arg += trimmed[i];
          i++;
        }
      }
      if (i < trimmed.length) i++; // skip closing quote
      parts.push(arg);
    } else {
      let arg = '';
      while (i < trimmed.length && trimmed[i] !== ' ') {
        arg += trimmed[i];
        i++;
      }
      parts.push(arg);
    }
  }

  if (parts.length === 0) {
    return [trimmed];
  }
  return parts as [string, ...string[]];
}

/**
 * Apply a chain of filters to a value.
 * Each filter string is like "upper" or "truncate 80" or "replace '-' '_'".
 */
export function applyFilters(value: unknown, filterChain: string[]): unknown {
  let result = value;
  for (const filterExpr of filterChain) {
    const [name, ...args] = parseFilterExpression(filterExpr);
    const fn = FILTERS.get(name);
    if (!fn) throw new Error(`Unknown template filter: ${name}`);
    result = fn(result, ...args);
  }
  return result;
}
