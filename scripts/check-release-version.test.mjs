import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { URL } from 'node:url';

import { validateReleaseVersions } from './check-release-version.mjs';

test('accepts matching release, package, and manifest versions', () => {
  for (const tag of ['2.0.31', '0.2.3', '1.0.0', '0.0.0', '2.3.10', '12.23.100', '1.2.3-rc.1', '1.2.3+build.01',
    '1.2.3-rc.1+build.01', '1.2.3-0.01a.-+build.00', '1.2.3--+-',
    '123456789012345678901234567890.0.0-9999999999999999999999+00']) {
    assert.doesNotThrow(() => validateReleaseVersions({
      tag,
      packageVersion: tag,
      manifestVersion: tag,
    }));
  }
});

for (const tag of [
  '01.2.3', '1.02.3', '1.2.03', '01.2.3-rc.1',
  '1.2.3-rc..1', '1.2.3-01', '1.2.3-rc.01+build.1',
  '1.2.3+.', '1.2.3+build..1', '1.2.3-rc.+build.1', '1.2.3-rc.1+build.',
  '1.2.3-rc_1', '1.2.3+bé', '1.2.3\n', ' 1.2.3', '1.2.3 ',
]) {
  test(`rejects aligned invalid release version ${JSON.stringify(tag)}`, () => {
    assert.throws(() => validateReleaseVersions({
      tag,
      packageVersion: tag,
      manifestVersion: tag,
    }), /Invalid or missing release tag/);
  });
}

for (const [tag, status, stderr] of [
  ['01.2.3', 1, 'Invalid or missing release tag: "01.2.3"\n'],
  ['1.02.3', 1, 'Invalid or missing release tag: "1.02.3"\n'],
  ['1.2.03', 1, 'Invalid or missing release tag: "1.2.03"\n'],
  ['0.0.0', 0, ''],
  ['12.23.100', 0, ''],
  ['1.2.3-rc.1+build.01', 0, ''],
  ['1.2.3--+-', 0, ''],
  ['1.2.3-rc..1', 1, 'Invalid or missing release tag: "1.2.3-rc..1"\n'],
  ['1.2.3-rc.01+build.1', 1, 'Invalid or missing release tag: "1.2.3-rc.01+build.1"\n'],
  ['1.2.3+build..1', 1, 'Invalid or missing release tag: "1.2.3+build..1"\n'],
  ['1.2.3\n', 1, 'Invalid or missing release tag: "1.2.3\\n"\n'],
]) {
  test(`CLI validates aligned release version ${tag}`, () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'claudian-release-version-')));
    try {
      mkdirSync(path.join(root, 'scripts'));
      const script = path.join(root, 'scripts/check-release-version.mjs');
      copyFileSync(new URL('./check-release-version.mjs', import.meta.url), script);
      for (const file of ['package.json', 'manifest.json']) {
        writeFileSync(path.join(root, file), JSON.stringify({ version: tag }));
      }
      const result = spawnSync(process.execPath, [script, tag], { cwd: root, encoding: 'utf8' });
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, status);
      assert.equal(result.stderr, stderr);
      assert.equal(result.stdout, '');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const [name, tag, packageVersion, manifestVersion] of [
  ['both documents', '2.0.32', '2.0.31', '2.0.31'],
  ['package only', '2.0.32', '2.0.31', '2.0.32'],
  ['manifest only', '2.0.32', '2.0.32', '2.0.31'],
  ['build metadata only', '1.2.3-rc.1+build.01', '1.2.3-rc.1+build.02', '1.2.3-rc.1+build.01'],
]) {
  test(`rejects version mismatches in ${name}`, () => {
    assert.throws(() => validateReleaseVersions({
      tag, packageVersion, manifestVersion,
    }), /Release version mismatch/);
  });
}

test('rejects malformed or missing release tags', () => {
  for (const tag of [undefined, '', 'v2.0.31', 'refs/tags/2.0.31']) {
    assert.throws(() => validateReleaseVersions({
      tag,
      packageVersion: '2.0.31',
      manifestVersion: '2.0.31',
    }), /Invalid or missing release tag/);
  }
});
