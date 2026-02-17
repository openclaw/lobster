import type { ErrorObject } from 'ajv';

export function formatValidationErrors(
  errors: ErrorObject[] | null | undefined,
  prefix: string,
): string {
  if (!errors?.length) return prefix;

  const details = errors.map((error) => {
    const path = normalizePath(error.instancePath);

    if (error.keyword === 'required') {
      const missing = String((error.params as any)?.missingProperty ?? '').trim();
      return missing ? `${missing} is required` : `${path || 'value'} is required`;
    }

    if (error.keyword === 'additionalProperties') {
      const property = String((error.params as any)?.additionalProperty ?? '').trim();
      return property ? `${property} is not allowed` : `${path || 'value'} has unsupported properties`;
    }

    return path ? `${path} ${error.message}` : String(error.message ?? 'invalid value');
  });

  return `${prefix}: ${details.join('; ')}`;
}

function normalizePath(instancePath: string): string {
  if (!instancePath) return '';
  return instancePath.replace(/^\//, '').replace(/\//g, '.');
}
