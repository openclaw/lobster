import { Ajv } from 'ajv';

import { formatValidationErrors } from './validation.js';

const ajv = new Ajv({ allErrors: true, strict: false });

export type LinkedinApplicantRecord = {
  candidate_name: string;
  candidate_email: string | null;
  candidate_phone: string | null;
  phone_type: string | null;
  linkedin_candidate_id: string;
  profile_url: string | null;
  project_id: string;
  project_name: string;
  stage: string;
  applied_at: string | null;
  location: string | null;
  headline: string | null;
  run_timestamp: string;

  raw_candidate_name: string | null;
  raw_candidate_email: string | null;
  raw_candidate_phone: string | null;
  raw_phone_type: string | null;
  raw_linkedin_candidate_id: string | null;
  raw_profile_url: string | null;
  raw_project_id: string | null;
  raw_project_name: string | null;
  raw_stage: string | null;
  raw_applied_at: string | null;
  raw_location: string | null;
  raw_headline: string | null;
};

export type LinkedinApplicantSyncBatch = {
  run_timestamp: string;
  records: LinkedinApplicantRecord[];
  extracted_count: number;
  failed_count: number;
};

export const linkedinApplicantRecordSchema = {
  $id: 'linkedinApplicantRecord.v1',
  type: 'object',
  properties: {
    candidate_name: { type: 'string', minLength: 1 },
    candidate_email: { anyOf: [{ type: 'string', pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' }, { type: 'null' }] },
    candidate_phone: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
    phone_type: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
    linkedin_candidate_id: { type: 'string', minLength: 1 },
    profile_url: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
    project_id: { type: 'string', minLength: 1 },
    project_name: { type: 'string', minLength: 1 },
    stage: { type: 'string', minLength: 1 },
    applied_at: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
    location: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
    headline: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
    run_timestamp: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$' },

    raw_candidate_name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    raw_candidate_email: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    raw_candidate_phone: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    raw_phone_type: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    raw_linkedin_candidate_id: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    raw_profile_url: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    raw_project_id: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    raw_project_name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    raw_stage: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    raw_applied_at: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    raw_location: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    raw_headline: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: [
    'candidate_name',
    'candidate_email',
    'candidate_phone',
    'phone_type',
    'linkedin_candidate_id',
    'profile_url',
    'project_id',
    'project_name',
    'stage',
    'applied_at',
    'location',
    'headline',
    'run_timestamp',
    'raw_candidate_name',
    'raw_candidate_email',
    'raw_candidate_phone',
    'raw_phone_type',
    'raw_linkedin_candidate_id',
    'raw_profile_url',
    'raw_project_id',
    'raw_project_name',
    'raw_stage',
    'raw_applied_at',
    'raw_location',
    'raw_headline',
  ],
  additionalProperties: false,
};

export const linkedinApplicantSyncBatchSchema = {
  $id: 'linkedinApplicantSyncBatch.v1',
  type: 'object',
  properties: {
    run_timestamp: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$' },
    records: { type: 'array', minItems: 1, items: linkedinApplicantRecordSchema },
    extracted_count: { type: 'number', minimum: 0 },
    failed_count: { type: 'number', minimum: 0 },
  },
  required: ['run_timestamp', 'records', 'extracted_count', 'failed_count'],
  additionalProperties: false,
};

const validateApplicantRecord = ajv.compile(linkedinApplicantRecordSchema);
const validateApplicantSyncBatch = ajv.compile(linkedinApplicantSyncBatchSchema);

export function assertLinkedinApplicantRecord(input: unknown): LinkedinApplicantRecord {
  if (!validateApplicantRecord(input)) {
    throw new Error(formatValidationErrors(validateApplicantRecord.errors, 'LinkedIn applicant record validation failed'));
  }

  return input as LinkedinApplicantRecord;
}

export function assertLinkedinApplicantSyncBatch(input: unknown): LinkedinApplicantSyncBatch {
  if (!validateApplicantSyncBatch(input)) {
    throw new Error(formatValidationErrors(validateApplicantSyncBatch.errors, 'LinkedIn applicant batch validation failed'));
  }

  return input as LinkedinApplicantSyncBatch;
}
