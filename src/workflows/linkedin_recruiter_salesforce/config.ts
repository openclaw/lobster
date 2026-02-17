import { Ajv } from 'ajv';

import { formatValidationErrors } from './validation.js';

const ajv = new Ajv({ allErrors: true, strict: false });

const REQUIRED_ENV_KEYS = [
  'LINKEDIN_RELAY_PROFILE',
  'LINKEDIN_RELAY_COMMAND',
  'LINKEDIN_RELAY_ATTACH_TIMEOUT_MS',
  'PEEKABOO_REATTACH_ENABLED',
  'SALESFORCE_INSTANCE_URL',
  'SALESFORCE_CLIENT_ID',
  'SALESFORCE_CLIENT_SECRET',
  'SALESFORCE_USERNAME',
  'SALESFORCE_PASSWORD',
  'SALESFORCE_SECURITY_TOKEN',
  'SALESFORCE_OBJECT_NAME',
  'SALESFORCE_EXTERNAL_ID_FIELD',
  'SALESFORCE_DRY_RUN',
  'SALESFORCE_MAX_RETRIES',
  'SALESFORCE_RETRY_BASE_MS',
  'SALESFORCE_RETRY_MAX_MS',
  'SALESFORCE_DEAD_LETTER_PATH',
  'SALESFORCE_FIELD_MAPPING_PATH',
  'SCHEDULER_CRON',
  'SCHEDULER_LOCAL_TIME',
  'SCHEDULER_TIMEZONE',
  'ARTIFACT_OUTPUT_PATH',
  'ARTIFACT_LOG_PATH',
  'ARTIFACT_SCHEMA_PATH',
] as const;

export type LinkedinApplicantSyncEnv = {
  [K in (typeof REQUIRED_ENV_KEYS)[number]]: string;
};

export type LinkedinApplicantSyncConfig = {
  linkedin: {
    relay_profile: string;
    relay_command: string;
    relay_attach_timeout_ms: number;
    peekaboo_reattach_enabled: boolean;
  };
  salesforce: {
    instance_url: string;
    client_id: string;
    client_secret: string;
    username: string;
    password: string;
    security_token: string;
    object_name: string;
    external_id_field: string;
    dry_run: boolean;
    max_retries: number;
    retry_base_ms: number;
    retry_max_ms: number;
    dead_letter_path: string;
    field_mapping_path: string;
  };
  scheduler: {
    cron: string;
    local_time: string;
    timezone: string;
  };
  artifact: {
    output_path: string;
    log_path: string;
    schema_path: string;
  };
};

export const linkedinApplicantSyncEnvSchema = {
  $id: 'linkedinApplicantSyncEnv.v1',
  type: 'object',
  properties: {
    LINKEDIN_RELAY_PROFILE: { type: 'string', minLength: 1 },
    LINKEDIN_RELAY_COMMAND: { type: 'string', minLength: 1 },
    LINKEDIN_RELAY_ATTACH_TIMEOUT_MS: { type: 'string', pattern: '^\\d+$' },
    PEEKABOO_REATTACH_ENABLED: { type: 'string', enum: ['true', 'false'] },

    SALESFORCE_INSTANCE_URL: { type: 'string', minLength: 1 },
    SALESFORCE_CLIENT_ID: { type: 'string', minLength: 1 },
    SALESFORCE_CLIENT_SECRET: { type: 'string', minLength: 1 },
    SALESFORCE_USERNAME: { type: 'string', minLength: 1 },
    SALESFORCE_PASSWORD: { type: 'string', minLength: 1 },
    SALESFORCE_SECURITY_TOKEN: { type: 'string', minLength: 1 },
    SALESFORCE_OBJECT_NAME: { type: 'string', minLength: 1 },
    SALESFORCE_EXTERNAL_ID_FIELD: { type: 'string', minLength: 1 },
    SALESFORCE_DRY_RUN: { type: 'string', enum: ['true', 'false'] },
    SALESFORCE_MAX_RETRIES: { type: 'string', pattern: '^\\d+$' },
    SALESFORCE_RETRY_BASE_MS: { type: 'string', pattern: '^\\d+$' },
    SALESFORCE_RETRY_MAX_MS: { type: 'string', pattern: '^\\d+$' },
    SALESFORCE_DEAD_LETTER_PATH: { type: 'string', minLength: 1 },
    SALESFORCE_FIELD_MAPPING_PATH: { type: 'string', minLength: 1 },

    SCHEDULER_CRON: { type: 'string', minLength: 1 },
    SCHEDULER_LOCAL_TIME: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
    SCHEDULER_TIMEZONE: { type: 'string', minLength: 1 },

    ARTIFACT_OUTPUT_PATH: { type: 'string', minLength: 1 },
    ARTIFACT_LOG_PATH: { type: 'string', minLength: 1 },
    ARTIFACT_SCHEMA_PATH: { type: 'string', minLength: 1 },
  },
  required: [...REQUIRED_ENV_KEYS],
  additionalProperties: true,
};

export const linkedinApplicantSyncConfigSchema = {
  $id: 'linkedinApplicantSyncConfig.v1',
  type: 'object',
  properties: {
    linkedin: {
      type: 'object',
      properties: {
        relay_profile: { type: 'string', minLength: 1 },
        relay_command: { type: 'string', minLength: 1 },
        relay_attach_timeout_ms: { type: 'number', minimum: 1 },
        peekaboo_reattach_enabled: { type: 'boolean' },
      },
      required: ['relay_profile', 'relay_command', 'relay_attach_timeout_ms', 'peekaboo_reattach_enabled'],
      additionalProperties: false,
    },
    salesforce: {
      type: 'object',
      properties: {
        instance_url: { type: 'string', minLength: 1 },
        client_id: { type: 'string', minLength: 1 },
        client_secret: { type: 'string', minLength: 1 },
        username: { type: 'string', minLength: 1 },
        password: { type: 'string', minLength: 1 },
        security_token: { type: 'string', minLength: 1 },
        object_name: { type: 'string', minLength: 1 },
        external_id_field: { type: 'string', minLength: 1 },
        dry_run: { type: 'boolean' },
        max_retries: { type: 'number', minimum: 0 },
        retry_base_ms: { type: 'number', minimum: 0 },
        retry_max_ms: { type: 'number', minimum: 0 },
        dead_letter_path: { type: 'string', minLength: 1 },
        field_mapping_path: { type: 'string', minLength: 1 },
      },
      required: [
        'instance_url',
        'client_id',
        'client_secret',
        'username',
        'password',
        'security_token',
        'object_name',
        'external_id_field',
        'dry_run',
        'max_retries',
        'retry_base_ms',
        'retry_max_ms',
        'dead_letter_path',
        'field_mapping_path',
      ],
      additionalProperties: false,
    },
    scheduler: {
      type: 'object',
      properties: {
        cron: { type: 'string', minLength: 1 },
        local_time: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
        timezone: { type: 'string', minLength: 1 },
      },
      required: ['cron', 'local_time', 'timezone'],
      additionalProperties: false,
    },
    artifact: {
      type: 'object',
      properties: {
        output_path: { type: 'string', minLength: 1 },
        log_path: { type: 'string', minLength: 1 },
        schema_path: { type: 'string', minLength: 1 },
      },
      required: ['output_path', 'log_path', 'schema_path'],
      additionalProperties: false,
    },
  },
  required: ['linkedin', 'salesforce', 'scheduler', 'artifact'],
  additionalProperties: false,
};

const validateEnvShape = ajv.compile(linkedinApplicantSyncEnvSchema);
const validateConfigShape = ajv.compile(linkedinApplicantSyncConfigSchema);

export function assertLinkedinApplicantSyncConfig(config: unknown): LinkedinApplicantSyncConfig {
  if (!validateConfigShape(config)) {
    throw new Error(formatValidationErrors(validateConfigShape.errors, 'LinkedIn applicant sync config validation failed'));
  }

  return config as LinkedinApplicantSyncConfig;
}

export function loadLinkedinApplicantSyncEnv(env: Record<string, string | undefined>): LinkedinApplicantSyncEnv {
  const value = Object.fromEntries(
    REQUIRED_ENV_KEYS
      .filter((key) => typeof env[key] !== 'undefined' && String(env[key]).trim() !== '')
      .map((key) => [key, String(env[key]).trim()]),
  );

  if (!validateEnvShape(value)) {
    throw new Error(
      formatValidationErrors(validateEnvShape.errors, 'LinkedIn applicant sync env validation failed'),
    );
  }

  return value as LinkedinApplicantSyncEnv;
}

export function loadLinkedinApplicantSyncConfigFromEnv(
  env: Record<string, string | undefined>,
): LinkedinApplicantSyncConfig {
  const parsed = loadLinkedinApplicantSyncEnv(env);

  const config: LinkedinApplicantSyncConfig = {
    linkedin: {
      relay_profile: parsed.LINKEDIN_RELAY_PROFILE,
      relay_command: parsed.LINKEDIN_RELAY_COMMAND,
      relay_attach_timeout_ms: Number(parsed.LINKEDIN_RELAY_ATTACH_TIMEOUT_MS),
      peekaboo_reattach_enabled: parsed.PEEKABOO_REATTACH_ENABLED === 'true',
    },
    salesforce: {
      instance_url: parsed.SALESFORCE_INSTANCE_URL,
      client_id: parsed.SALESFORCE_CLIENT_ID,
      client_secret: parsed.SALESFORCE_CLIENT_SECRET,
      username: parsed.SALESFORCE_USERNAME,
      password: parsed.SALESFORCE_PASSWORD,
      security_token: parsed.SALESFORCE_SECURITY_TOKEN,
      object_name: parsed.SALESFORCE_OBJECT_NAME,
      external_id_field: parsed.SALESFORCE_EXTERNAL_ID_FIELD,
      dry_run: parsed.SALESFORCE_DRY_RUN === 'true',
      max_retries: Number(parsed.SALESFORCE_MAX_RETRIES),
      retry_base_ms: Number(parsed.SALESFORCE_RETRY_BASE_MS),
      retry_max_ms: Number(parsed.SALESFORCE_RETRY_MAX_MS),
      dead_letter_path: parsed.SALESFORCE_DEAD_LETTER_PATH,
      field_mapping_path: parsed.SALESFORCE_FIELD_MAPPING_PATH,
    },
    scheduler: {
      cron: parsed.SCHEDULER_CRON,
      local_time: parsed.SCHEDULER_LOCAL_TIME,
      timezone: parsed.SCHEDULER_TIMEZONE,
    },
    artifact: {
      output_path: parsed.ARTIFACT_OUTPUT_PATH,
      log_path: parsed.ARTIFACT_LOG_PATH,
      schema_path: parsed.ARTIFACT_SCHEMA_PATH,
    },
  };

  return assertLinkedinApplicantSyncConfig(config);
}
