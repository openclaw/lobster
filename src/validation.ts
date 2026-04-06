import { Ajv } from 'ajv';

export const sharedAjv = new Ajv({
  allErrors: false,
  strict: false,
  // User-provided schemas may repeat `$id` across runs/resumes.
  addUsedSchema: false,
});
