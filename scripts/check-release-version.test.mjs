import assert from 'node:assert/strict';
import test from 'node:test';

import { validateReleaseVersions } from './check-release-version.mjs';

test('accepts matching release, package, and manifest versions', () => {
  assert.doesNotThrow(() => validateReleaseVersions({
    tag: '2.0.31',
    packageVersion: '2.0.31',
    manifestVersion: '2.0.31',
  }));
});

test('rejects version mismatches', () => {
  assert.throws(() => validateReleaseVersions({
    tag: '2.0.32',
    packageVersion: '2.0.31',
    manifestVersion: '2.0.31',
  }), /Release version mismatch/);
});

test('rejects malformed or missing release tags', () => {
  for (const tag of [undefined, '', 'v2.0.31', 'refs/tags/2.0.31']) {
    assert.throws(() => validateReleaseVersions({
      tag,
      packageVersion: '2.0.31',
      manifestVersion: '2.0.31',
    }), /Invalid or missing release tag/);
  }
});
