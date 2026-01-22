/**
 * GitHub Recipes
 *
 * @example
 * import { prMonitor, prMonitorNotify } from 'lobster/recipes/github';
 *
 * const result = await prMonitor({ repo: 'owner/repo', pr: 123 }).run();
 */

export { prMonitor, prMonitorNotify } from './pr-monitor.js';
export { ghPrView } from './stages/pr-view.js';

// Register recipes
import { registerRecipe } from '../registry.js';
import { prMonitor, prMonitorNotify } from './pr-monitor.js';

registerRecipe(prMonitor);
registerRecipe(prMonitorNotify);
