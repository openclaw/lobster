import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertLinkedinApplicantSyncConfig,
  loadLinkedinApplicantSyncConfigFromEnv,
} from '../src/workflows/linkedin_recruiter_salesforce/config.js';

function validEnv() {
  return {
    LINKEDIN_RELAY_PROFILE: 'chrome',
    LINKEDIN_RELAY_COMMAND: 'openclaw-browser-relay',
    LINKEDIN_RELAY_ATTACH_TIMEOUT_MS: '30000',
    PEEKABOO_REATTACH_ENABLED: 'true',

    SALESFORCE_INSTANCE_URL: 'https://example.my.salesforce.com',
    SALESFORCE_CLIENT_ID: 'client-id',
    SALESFORCE_CLIENT_SECRET: 'client-secret',
    SALESFORCE_USERNAME: 'automation@example.com',
    SALESFORCE_PASSWORD: 'password',
    SALESFORCE_SECURITY_TOKEN: 'security-token',
    SALESFORCE_OBJECT_NAME: 'LinkedIn_Applicant__c',
    SALESFORCE_EXTERNAL_ID_FIELD: 'External_Key__c',
    SALESFORCE_DRY_RUN: 'true',
    SALESFORCE_MAX_RETRIES: '3',
    SALESFORCE_RETRY_BASE_MS: '500',
    SALESFORCE_RETRY_MAX_MS: '5000',
    SALESFORCE_DEAD_LETTER_PATH: './artifacts/dead-letter.jsonl',
    SALESFORCE_FIELD_MAPPING_PATH: './config/salesforce-field-mapping.json',

    SCHEDULER_CRON: '0 9 * * *',
    SCHEDULER_LOCAL_TIME: '09:00',
    SCHEDULER_TIMEZONE: 'America/Chicago',

    ARTIFACT_OUTPUT_PATH: './artifacts/linkedin-applicants.json',
    ARTIFACT_LOG_PATH: './artifacts/linkedin-sync.log',
    ARTIFACT_SCHEMA_PATH: './artifacts/linkedin-applicant-schema.json',
  };
}

test('loadLinkedinApplicantSyncConfigFromEnv parses env into typed config', () => {
  const config = loadLinkedinApplicantSyncConfigFromEnv(validEnv());

  assert.equal(config.linkedin.relay_profile, 'chrome');
  assert.equal(config.linkedin.relay_attach_timeout_ms, 30000);
  assert.equal(config.linkedin.peekaboo_reattach_enabled, true);
  assert.equal(config.salesforce.dry_run, true);
  assert.equal(config.salesforce.max_retries, 3);
  assert.equal(config.scheduler.timezone, 'America/Chicago');
});

test('loadLinkedinApplicantSyncConfigFromEnv rejects missing env vars with explicit messages', () => {
  const env = validEnv();
  delete (env as any).SALESFORCE_CLIENT_SECRET;

  assert.throws(
    () => loadLinkedinApplicantSyncConfigFromEnv(env),
    /LinkedIn applicant sync env validation failed: SALESFORCE_CLIENT_SECRET is required/,
  );
});

test('loadLinkedinApplicantSyncConfigFromEnv rejects invalid env values', () => {
  const env = validEnv();
  (env as any).SCHEDULER_LOCAL_TIME = '25:70';

  assert.throws(
    () => loadLinkedinApplicantSyncConfigFromEnv(env),
    /LinkedIn applicant sync env validation failed: SCHEDULER_LOCAL_TIME must match pattern/,
  );
});

test('assertLinkedinApplicantSyncConfig rejects invalid config shape', () => {
  assert.throws(
    () =>
      assertLinkedinApplicantSyncConfig({
        linkedin: {
          relay_profile: 'chrome',
          relay_command: 'openclaw-browser-relay',
          relay_attach_timeout_ms: 30000,
          peekaboo_reattach_enabled: true,
        },
      }),
    /LinkedIn applicant sync config validation failed: salesforce is required/,
  );
});
