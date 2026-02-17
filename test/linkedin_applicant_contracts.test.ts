import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertLinkedinApplicantRecord,
  assertLinkedinApplicantSyncBatch,
  linkedinApplicantRecordSchema,
} from '../src/workflows/linkedin_recruiter_salesforce/contracts.js';

function validRecord() {
  return {
    candidate_name: 'Ada Lovelace',
    candidate_email: 'ada@example.com',
    candidate_phone: '+15551234567',
    phone_type: 'mobile',
    linkedin_candidate_id: 'urn:li:fsd_profile:123',
    profile_url: 'https://www.linkedin.com/talent/profile/123',
    project_id: 'project-1',
    project_name: 'O+ Recruiting',
    stage: 'New Applicant',
    applied_at: '2026-02-16T12:34:56.000Z',
    location: 'Chicago, IL',
    headline: 'Senior Software Engineer',
    run_timestamp: '2026-02-17T17:00:00.000Z',

    raw_candidate_name: '  Ada Lovelace ',
    raw_candidate_email: 'Ada@Example.com ',
    raw_candidate_phone: '(555) 123-4567',
    raw_phone_type: 'Mobile',
    raw_linkedin_candidate_id: 'urn:li:fsd_profile:123',
    raw_profile_url: 'https://www.linkedin.com/talent/profile/123/',
    raw_project_id: 'project-1',
    raw_project_name: ' O+ Recruiting ',
    raw_stage: 'New Applicant',
    raw_applied_at: 'Feb 16, 2026',
    raw_location: 'Chicago, IL, United States',
    raw_headline: 'Senior Software Engineer @ Example Co',
  };
}

test('applicant schema includes all required normalized + raw fields', () => {
  const required = new Set(linkedinApplicantRecordSchema.required ?? []);

  for (const field of [
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
  ]) {
    assert.equal(required.has(field), true, `missing required field in schema: ${field}`);
  }
});

test('assertLinkedinApplicantRecord accepts a valid applicant payload', () => {
  const record = validRecord();
  const parsed = assertLinkedinApplicantRecord(record);

  assert.equal(parsed.candidate_name, 'Ada Lovelace');
  assert.equal(parsed.project_name, 'O+ Recruiting');
});

test('assertLinkedinApplicantRecord rejects missing required fields with explicit errors', () => {
  const record = validRecord();
  delete (record as any).project_id;

  assert.throws(
    () => assertLinkedinApplicantRecord(record),
    /LinkedIn applicant record validation failed: project_id is required/,
  );
});

test('assertLinkedinApplicantSyncBatch validates record arrays and metadata', () => {
  const batch = {
    run_timestamp: '2026-02-17T17:00:00.000Z',
    records: [validRecord()],
    extracted_count: 1,
    failed_count: 0,
  };

  const parsed = assertLinkedinApplicantSyncBatch(batch);
  assert.equal(parsed.records.length, 1);

  assert.throws(
    () =>
      assertLinkedinApplicantSyncBatch({
        ...batch,
        records: [],
      }),
    /LinkedIn applicant batch validation failed: records must NOT have fewer than 1 items/,
  );
});
