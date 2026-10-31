import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { inspectLockfileParity } from './check-lockfile-parity.mjs';

const script = path.join(process.cwd(), 'scripts/check-lockfile-parity.mjs');

const packageLock = {
  packages: {
    '': { name: 'claudian', version: '1.0.0' },
    'node_modules/express': { version: '5.2.1' },
    'node_modules/content-disposition': { version: '2.0.1' },
    'node_modules/eslint-plugin-react/node_modules/minimatch': { version: '11.0.3' },
    'node_modules/minimatch': { version: '11.0.3' },
    'node_modules/@scope/pkg': { version: '1.2.3' },
    'node_modules/string-width-cjs': { name: 'string-width', version: '4.2.3' },
    'node_modules/local': { link: true, resolved: 'packages/local' },
  },
};

const bunLock = {
  packages: {
    express: ['express@5.2.1', '', {}, 'sha512-a'],
    'content-disposition': ['content-disposition@2.0.1', '', {}, 'sha512-b'],
    minimatch: ['minimatch@11.0.3', '', {}, 'sha512-c'],
    '@scope/pkg': ['@scope/pkg@1.2.3', '', {}, 'sha512-d'],
    'string-width-cjs': ['string-width@4.2.3', '', {}, 'sha512-e'],
    local: ['local@workspace:packages/local'],
  },
};

test('lockfiles that install the same versions pass regardless of hoisting', () => {
  assert.deepEqual(inspectLockfileParity({ bunLock, packageLock }), { onlyBun: [], onlyNpm: [] });
});

test('a version that only one lockfile resolves is reported on both sides', () => {
  const staleBunLock = structuredClone(bunLock);
  staleBunLock.packages['content-disposition'][0] = 'content-disposition@1.1.0';
  assert.deepEqual(inspectLockfileParity({ bunLock: staleBunLock, packageLock }), {
    onlyBun: ['content-disposition@1.1.0'],
    onlyNpm: ['content-disposition@2.0.1'],
  });
});

test('a package missing from one lockfile is reported', () => {
  const extraNpmLock = structuredClone(packageLock);
  extraNpmLock.packages['node_modules/@scope/extra'] = { version: '0.1.0' };
  assert.deepEqual(inspectLockfileParity({ bunLock, packageLock: extraNpmLock }), {
    onlyBun: [],
    onlyNpm: ['@scope/extra@0.1.0'],
  });
});

test('the CLI fails with a regeneration hint on drift and passes when synced', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-lockfile-parity-'));
  try {
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(packageLock));
    fs.writeFileSync(path.join(root, 'bun.lock'), JSON.stringify(bunLock));
    const synced = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    assert.equal(synced.status, 0, synced.stderr);

    const drifted = structuredClone(bunLock);
    drifted.packages.express[0] = 'express@5.1.0';
    fs.writeFileSync(path.join(root, 'bun.lock'), JSON.stringify(drifted));
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /only in package-lock\.json: express@5\.2\.1/);
    assert.match(result.stderr, /only in bun\.lock: express@5\.1\.0/);
    assert.match(result.stderr, /rm bun\.lock && bun install --lockfile-only/);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});
