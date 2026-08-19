#!/usr/bin/env node
/**
 * Packed-artifact verification for @claudian/collab-protocol.
 *
 * 1. builds the package;
 * 2. packs it and asserts the exact published file inventory;
 * 3. installs the tarball into a clean temporary consumer using only the
 *    dependency metadata in the packed artifact;
 * 4. executes CJS and ESM import smoke tests, including a runtime codec
 *    round-trip through the installed artifact.
 *
 * All artifacts stay under the repository's ignored .context/ directory.
 */
import {
  execFileSync,
  execSync,
} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const packageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const contextRoot = path.join(repoRoot, '.context');
mkdirSync(contextRoot, { recursive: true });

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? packageRoot,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
    ...options,
  }).trim();
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`verify-pack failure: ${message}`);
  }
}

const workRoot = mkdtempSync(path.join(contextRoot, 'collab-protocol-pack-'));
console.log(`workspace: ${workRoot}`);

// 1. Build + pack.
run('npm', ['run', 'build']);
const tarballName = run('npm', ['pack', '--pack-destination', workRoot]);
const tarballPath = path.join(workRoot, tarballName);
assert(existsSync(tarballPath), `tarball missing: ${tarballPath}`);
console.log(`packed: ${tarballName}`);

// 2. Exact packed-file inventory: dist build output, package.json, README.md.
const expectedFiles = [
  'package/README.md',
  'package/package.json',
  ...readdirSync(path.join(packageRoot, 'src'))
    .filter(name => name.endsWith('.ts'))
    .flatMap((name) => {
      const base = name.replace(/\.ts$/, '');
      return [`package/dist/${base}.js`, `package/dist/${base}.d.ts`];
    }),
].sort();
const packedFiles = run('tar', ['-tzf', tarballPath])
  .split('\n')
  .map(entry => entry.trim())
  .filter(Boolean)
  .sort();
assert(
  JSON.stringify(packedFiles) === JSON.stringify(expectedFiles),
  `packed inventory mismatch:\nexpected: ${JSON.stringify(expectedFiles, null, 2)}\nactual: ${JSON.stringify(packedFiles, null, 2)}`,
);
console.log(`inventory: ${packedFiles.length} files exactly as expected`);

// 3. Clean consumer install without registry access.
const consumerRoot = path.join(workRoot, 'consumer');
mkdirSync(consumerRoot);
writeFileSync(
  path.join(consumerRoot, 'package.json'),
  JSON.stringify(
    {
      name: 'collab-protocol-consumer-smoke',
      private: true,
      version: '0.0.0',
      dependencies: {
        '@claudian/collab-protocol': `file:${tarballPath}`,
      },
    },
    null,
    2,
  ),
);
run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: consumerRoot });
const installedManifest = JSON.parse(readFileSync(
  path.join(consumerRoot, 'node_modules', '@claudian/collab-protocol', 'package.json'),
  'utf8',
));
console.log(`installed artifact version: ${installedManifest.version}`);

// 4. Runtime smoke: CJS require, then ESM import, with codec execution.
const smokeSource = `
const assert = require('node:assert/strict');
const protocol = require('@claudian/collab-protocol');
const packageVersion = ${JSON.stringify(installedManifest.version)};

assert.equal(protocol.COLLAB_PROTOCOL_VERSION, 1);
assert.notEqual(packageVersion, String(protocol.COLLAB_PROTOCOL_VERSION));
assert.match(packageVersion, /^0\\./);

const codec = protocol.COLLAB_CONTROL_OPERATION_CODECS.ensureMyRequest;
const valid = codec.decodeRequest({
  projectId: 'project_1',
  idempotencyKey: 'key_1',
  expectedMainOid: '${'1'.repeat(40)}',
  headOid: '${'2'.repeat(40)}',
  description: 'Resolves #3',
});
assert.equal(valid.status, 'ok');
assert.equal(codec.decodeRequest({ projectId: 42 }).status, 'invalid');
// Additive-tolerant request decoders accept unknown fields (accepted
// compatibility behavior for these operations).
assert.equal(
  codec.decodeRequest({
    projectId: 'project_1',
    idempotencyKey: 'key_1',
    expectedMainOid: '${'1'.repeat(40)}',
    headOid: '${'2'.repeat(40)}',
    description: '',
    unknownField: true,
  }).status,
  'ok',
);
assert.throws(
  () => protocol.collabControlOperationCodec('no-such-operation'),
  error => error instanceof protocol.CollabError && error.code === 'operation-failed',
);

const unsupported = protocol.decodeCollabProtocolEnvelope({
  protocolVersion: 999,
  requestId: 'request_1',
  data: {},
});
assert.equal(unsupported.status, 'unsupported-version');

const references = protocol.parseCollabTicketReferences('Resolves #3 and see #7');
assert.equal(references.status, 'ok');
assert.deepEqual(
  references.references,
  [
    { ticketNumber: 3, kind: 'resolves' },
    { ticketNumber: 7, kind: 'references' },
  ],
);

const error = new protocol.CollabError({
  code: 'operation-failed',
  safeContext: { memberCredential: 'secret', path: '/Users/private/vault' },
});
assert.equal(error.safeContext.memberCredential, undefined);
assert.equal(error.safeContext.path, '[PATH]');

console.log('smoke: version, shared registry, codecs, parsers, safe errors OK');
`;
writeFileSync(path.join(consumerRoot, 'smoke.cjs'), smokeSource);
const cjsOutput = run('node', ['smoke.cjs'], { cwd: consumerRoot });
console.log(`cjs ${cjsOutput}`);

const esmOutput = run('node', [
  '--input-type=module',
  '-e',
  "import { COLLAB_PROTOCOL_VERSION, collabMemberRef } from '@claudian/collab-protocol';"
    + " if (COLLAB_PROTOCOL_VERSION !== 1 || collabMemberRef('member_1') !== 'refs/heads/members/member_1') process.exit(1);"
    + " console.log('esm import OK');",
], { cwd: consumerRoot });
console.log(esmOutput);

// 5. Subpath imports must be blocked by the exports map.
for (const subpath of ['dist/CollabError.js', 'package.json']) {
  execSync(
    `node -e "try { require('@claudian/collab-protocol/${subpath}'); process.exit(3); }`
      + ' catch { process.exit(0); }" ',
    { cwd: consumerRoot, encoding: 'utf8' },
  );
}
console.log('subpath import blocked as expected');

console.log('verify-pack: PASS');
