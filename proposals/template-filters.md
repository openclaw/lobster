# Feature Proposal: Template Filters

## Problem

Lobster's template engine (`src/commands/stdlib/template.ts`) supports only `{{field}}` path access with no transformation capabilities. The `renderTemplate` function (line 14) is a simple regex replacement:

```typescript
function renderTemplate(tpl: string, ctx: any): string {
  return tpl.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, expr) => {
    const key = String(expr ?? '').trim();
    const val = getByPath(ctx, key);
    if (val === undefined || val === null) return '';
    if (typeof val === 'string') return val;
    return JSON.stringify(val);
  });
}
```

There are no filters, no transformations, no conditionals within templates. To transform a value, you need a separate `map` or `exec` step with `jq`, adding friction and pipeline stages for trivial operations.

The same limitation exists in `resolveTemplate` within `file.ts` which handles `${arg}` substitutions in workflow step commands.

## Why This Matters

Common template needs that currently require extra steps:
- `{{title | upper}}` — uppercase a title for a notification header
- `{{items | length}}` — show count in a summary message
- `{{body | truncate 100}}` — preview text in an approval prompt
- `{{date | date 'YYYY-MM-DD'}}` — format a timestamp
- `{{name | default 'Unknown'}}` — handle missing values gracefully
- `{{tags | join ', '}}` — comma-separate an array for display

Without filters, a simple "PR #{{number}}: {{title | upper}}" template requires an upstream `map` step to pre-transform the data, which clutters the pipeline with plumbing steps.

## Proposed Syntax

```bash
# Pipeline command
... | template --text 'PR #{{number}}: {{title | upper}}'
... | template --text '{{items | length}} items found'
... | template --text '{{body | truncate 80}}'
... | template --text '{{name | default "Anonymous"}}'
... | template --text '{{tags | join ", "}}'
... | template --text '{{amount | round 2}}'

# Workflow step templates
steps:
  - id: notify
    run: echo "Found {{$fetch.json | length}} results as of {{now | date 'YYYY-MM-DD'}}"
```

### Filter Chaining

Filters chain left-to-right with `|`:

```
{{title | lower | truncate 50}}
{{items | first | json}}
```

### Filter Arguments

Arguments follow the filter name, separated by spaces. String arguments use quotes:

```
{{body | truncate 100}}
{{name | default "N/A"}}
{{amount | round 2}}
{{items | join ", "}}
```

## Proposed Filter Set (15 essential filters)

### String Filters
| Filter | Example | Description |
|--------|---------|-------------|
| `upper` | `{{name \| upper}}` | Uppercase |
| `lower` | `{{name \| lower}}` | Lowercase |
| `trim` | `{{text \| trim}}` | Strip whitespace |
| `truncate N` | `{{body \| truncate 100}}` | Truncate with `...` |
| `replace from to` | `{{s \| replace "-" "_"}}` | String replacement |
| `split sep` | `{{csv \| split ","}}` | Split to array |

### Array Filters
| Filter | Example | Description |
|--------|---------|-------------|
| `first` | `{{items \| first}}` | First element |
| `last` | `{{items \| last}}` | Last element |
| `length` | `{{items \| length}}` | Count items |
| `join sep` | `{{tags \| join ", "}}` | Join array to string |

### Type Filters
| Filter | Example | Description |
|--------|---------|-------------|
| `json` | `{{obj \| json}}` | Pretty-print as JSON |
| `string` | `{{num \| string}}` | Coerce to string |
| `default val` | `{{name \| default "N/A"}}` | Fallback for null/undefined |

### Math Filters
| Filter | Example | Description |
|--------|---------|-------------|
| `round N` | `{{price \| round 2}}` | Round to N decimals |

### Date Filters
| Filter | Example | Description |
|--------|---------|-------------|
| `date fmt` | `{{ts \| date "YYYY-MM-DD"}}` | Format ISO date |

## Implementation Approach

### 1. New filter registry: `src/core/filters.ts`

```typescript
type FilterFn = (value: any, ...args: string[]) => any;

const FILTERS: Map<string, FilterFn> = new Map([
  ['upper', (v) => String(v).toUpperCase()],
  ['lower', (v) => String(v).toLowerCase()],
  ['trim', (v) => String(v).trim()],
  ['truncate', (v, n) => {
    const s = String(v), len = parseInt(n) || 80;
    return s.length > len ? s.slice(0, len) + '...' : s;
  }],
  ['length', (v) => Array.isArray(v) ? v.length : String(v).length],
  ['first', (v) => Array.isArray(v) ? v[0] : v],
  ['last', (v) => Array.isArray(v) ? v[v.length - 1] : v],
  ['join', (v, sep) => Array.isArray(v) ? v.join(sep ?? ', ') : String(v)],
  ['default', (v, def) => (v == null || v === '') ? def : v],
  ['json', (v) => JSON.stringify(v, null, 2)],
  ['string', (v) => String(v)],
  ['round', (v, n) => {
    const num = Number(v), dec = parseInt(n) || 0;
    return isNaN(num) ? v : Number(num.toFixed(dec));
  }],
  ['replace', (v, from, to) => String(v).replaceAll(from ?? '', to ?? '')],
  ['split', (v, sep) => String(v).split(sep ?? ',')],
  ['date', (v, fmt) => formatDate(v, fmt)],
]);

export function applyFilters(value: any, filterChain: string[]): any {
  let result = value;
  for (const filter of filterChain) {
    const [name, ...args] = parseFilterExpression(filter);
    const fn = FILTERS.get(name);
    if (!fn) throw new Error(`Unknown filter: ${name}`);
    result = fn(result, ...args);
  }
  return result;
}
```

### 2. Update `renderTemplate` in `template.ts`

Change the regex handler to split on `|` inside braces and chain filter functions:

```typescript
function renderTemplate(tpl: string, ctx: any): string {
  return tpl.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, expr) => {
    const parts = String(expr).split('|').map(s => s.trim());
    const key = parts[0];
    let val = getByPath(ctx, key);
    if (parts.length > 1) {
      val = applyFilters(val, parts.slice(1));
    }
    if (val === undefined || val === null) return '';
    if (typeof val === 'string') return val;
    return JSON.stringify(val);
  });
}
```

### 3. Update `resolveTemplate` in `file.ts`

Apply the same filter support to `${arg | filter}` expressions in workflow step commands.

## Files to Modify

| File | Change |
|------|--------|
| New: `src/core/filters.ts` | Filter registry + implementations (~100 lines) |
| `src/commands/stdlib/template.ts` | Update `renderTemplate` to support `|` filter syntax |
| `src/workflows/file.ts` | Update `resolveTemplate` for workflow-level filter support |
| `test/` | Filter unit tests, template integration tests |

## Complexity: Small

- Filter registry: ~100 lines
- Template parser update: ~15 lines
- Workflow template update: ~10 lines
- Tests: ~80 lines
- Zero new dependencies (all filters use built-in JS)

## Design Notes

- **Zero dependencies**: All filters are pure JS functions. No Nunjucks or Handlebars required.
- **Backward compatible**: Templates without `|` work exactly as before.
- **Extensible**: The `Map<string, FilterFn>` pattern makes it trivial to add new filters later, or even allow plugins to register custom filters.
- **Deterministic**: Filters are pure functions with no side effects.
- **Consistent**: Same filter syntax works in both pipeline `template` command and workflow step templates.
