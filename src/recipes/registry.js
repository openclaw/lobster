/**
 * Recipe registry for discovery.
 */

import { prMonitor, prMonitorNotify } from "./github/pr-monitor.js";

const recipes = {
  "github.pr.monitor": prMonitor,
  "github.pr.monitor.notify": prMonitorNotify,
};

export function listRecipes() {
  return Object.entries(recipes).map(([name, fn]) => {
    const meta = fn.meta ?? {};
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
