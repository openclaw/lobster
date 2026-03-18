import { Ajv } from 'ajv';

export const sharedAjv = new Ajv({ allErrors: false, strict: false });
