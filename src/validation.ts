import { Ajv, type AnySchema, type ValidateFunction } from 'ajv';
import { stableStringify } from './state/store.js';

export const sharedAjv = new Ajv({
  allErrors: false,
  strict: false,
  // User-provided schemas may repeat `$id` across runs/resumes.
  addUsedSchema: false,
});

/**
 * Build a memoized `compile()` for a given Ajv instance.
 *
 * Calling `ajv.compile(schema)` per-request leaks SchemaEnv / closure graphs
 * that Ajv retains indefinitely (issue #96 — heap profile measured
 * +1.19M nodes, +114 MiB over 3.5h on a ~1 compile/s workload). Memoization
 * eliminates the leak for the common case where the same schema is recompiled
 * across calls.
 *
 * Cache key is the stable JSON serialization of the schema, which catches
 * structurally-identical schemas across reloads even when keys are inserted
 * in different orders.
 *
 * Each Ajv instance gets its own cache (different instances may have
 * different config — e.g. `allErrors: true` vs `false` — so their compiled
 * validators are not interchangeable).
 */
export function createCompileCached(ajv: Ajv): (schema: AnySchema) => ValidateFunction {
  const cache = new Map<string, ValidateFunction>();
  return function compileCached(schema: AnySchema): ValidateFunction {
    const key = stableStringify(schema);
    let validator = cache.get(key);
    if (!validator) {
      validator = ajv.compile(schema);
      cache.set(key, validator);
    }
    return validator;
  };
}

/** Memoized compile bound to the module-level `sharedAjv` instance. */
export const compileCached = createCompileCached(sharedAjv);
