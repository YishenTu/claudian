import assert from 'node:assert/strict';
import test from 'node:test';

import { unacceptedVulnerabilities } from './audit-dependencies.mjs';

const advisory = (id, severity = 'moderate') => ({ url: `https://github.com/advisories/${id}`, severity });
const accepted = new Map([['GHSA-accepted', 'test']]);

test('packages vulnerable only through an accepted advisory pass, including transitive dependents', () => {
  const report = { vulnerabilities: {
    minimatch: { severity: 'moderate', via: [advisory('GHSA-accepted')] },
    eslint: { severity: 'moderate', via: ['minimatch'] },
    plugin: { severity: 'moderate', via: ['eslint'] },
  } };
  assert.deepEqual(unacceptedVulnerabilities(report, accepted), []);
});

test('an unaccepted advisory fails its package and every dependent, even beside an accepted one', () => {
  const report = { vulnerabilities: {
    minimatch: { severity: 'moderate', via: [advisory('GHSA-accepted'), advisory('GHSA-new')] },
    eslint: { severity: 'moderate', via: ['minimatch'] },
    other: { severity: 'high', via: [advisory('GHSA-other', 'high')] },
  } };
  assert.deepEqual(unacceptedVulnerabilities(report, accepted), [
    { name: 'minimatch', severity: 'moderate' },
    { name: 'eslint', severity: 'moderate' },
    { name: 'other', severity: 'high' },
  ]);
});

test('advisories below the threshold and dependency cycles do not fail', () => {
  const report = { vulnerabilities: {
    quiet: { severity: 'low', via: [advisory('GHSA-low', 'low')] },
    a: { severity: 'moderate', via: ['b'] },
    b: { severity: 'moderate', via: ['a'] },
  } };
  assert.deepEqual(unacceptedVulnerabilities(report, accepted), []);
});
