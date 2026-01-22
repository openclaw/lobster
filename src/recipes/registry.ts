/**
 * Recipe registry for discovery.
 */

import { prMonitor, prMonitorNotify } from "./github/pr-monitor.js";

const recipes: Record<string, any> = {
  "github.pr.monitor": prMonitor,
  "github.pr.monitor.notify": prMonitorNotify,
};

export function registerRecipe(fn) {
  const meta = fn?.meta ?? {};
  const name = meta.name;
  if (!name) throw new Error("Recipe is missing meta.name");
  recipes[name] = fn;
}

export function listRecipes() {
  return Object.entries(recipes).map(([name, fn]) => {
    const meta: any = (fn as any).meta ?? {};
    return {
      name,
      description: meta.description ?? "",
      requires: meta.requires ?? [],
      args: meta.args ?? {},
    };
  });
}

export function getRecipe(name) {
  return recipes[name];
}
