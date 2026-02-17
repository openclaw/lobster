export function getByPath(obj: any, path: string): any {
  if (path === '.' || path === 'this') return obj;
  const parts = path.split('.').filter(Boolean);
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    if (!Object.hasOwn(cur, p)) return undefined;
    cur = cur[p];
  }
  return cur;
}

export function renderTemplate(tpl: string, ctx: any): string {
  return tpl.replace(/\{\{([^}]+)\}\}/g, (_m, expr) => {
    const key = String(expr ?? '').trim();
    const val = getByPath(ctx, key);
    if (val === undefined || val === null) return '';
    if (typeof val === 'string') return val;
    return JSON.stringify(val);
  });
}
