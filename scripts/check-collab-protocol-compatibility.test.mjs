import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertVersionedContractChange,
  digestTypeScriptBehavior,
  readBaseSnapshot,
  snapshotsHaveEqualContract,
} from './check-collab-protocol-compatibility.mjs';

function snapshot({
  contract = { operations: ['getRequest'] },
  packageVersion = '0.1.0',
  protocolVersion = 1,
} = {}) {
  return {
    contract,
    packageVersion,
    protocolVersion,
    schemaVersion: 1,
  };
}

test('accepts an unchanged contract without version churn', () => {
  const base = snapshot();
  const current = snapshot();

  assert.equal(snapshotsHaveEqualContract(base, current), true);
  assert.doesNotThrow(() => assertVersionedContractChange(base, current));
});

test('rejects a contract change without package and wire version increments', () => {
  const base = snapshot();
  const changed = snapshot({ contract: { operations: ['getRequest', 'createTicket'] } });

  assert.equal(snapshotsHaveEqualContract(base, changed), false);
  assert.throws(
    () => assertVersionedContractChange(base, changed),
    /package version must increase.*wire protocol version must increase/s,
  );
});

test('accepts a contract change with monotonic package and wire versions', () => {
  const base = snapshot();
  const changed = snapshot({
    contract: { operations: ['getRequest', 'createTicket'] },
    packageVersion: '0.2.0',
    protocolVersion: 2,
  });

  assert.doesNotThrow(() => assertVersionedContractChange(base, changed));
});

test('rejects a patch-only package bump for a changed pre-1.0 contract', () => {
  const base = snapshot();
  const changed = snapshot({
    contract: { operations: ['getRequest', 'createTicket'] },
    packageVersion: '0.1.1',
    protocolVersion: 2,
  });

  assert.throws(
    () => assertVersionedContractChange(base, changed),
    /at least a minor release/u,
  );
});

test('accepts a major package bump for a changed pre-1.0 contract', () => {
  const base = snapshot();
  const changed = snapshot({
    contract: { operations: ['getRequest', 'createTicket'] },
    packageVersion: '1.0.0',
    protocolVersion: 2,
  });

  assert.doesNotThrow(() => assertVersionedContractChange(base, changed));
});

test('accepts a patch bump when the contract is unchanged', () => {
  const base = snapshot();
  const current = snapshot({ packageVersion: '0.1.1' });

  assert.doesNotThrow(() => assertVersionedContractChange(base, current));
});

test('rejects a version rollback even when the contract is unchanged', () => {
  const base = snapshot({ packageVersion: '0.2.0', protocolVersion: 2 });
  const current = snapshot({ packageVersion: '0.1.9', protocolVersion: 1 });

  assert.throws(
    () => assertVersionedContractChange(base, current),
    /package version cannot decrease.*wire protocol version cannot decrease/s,
  );
});

test('decoder behavior digests ignore comments and formatting', () => {
  const compact = 'export function decode(value: unknown) { return value; }';
  const formatted = `
    // Documentation must not require a wire-version bump.
    export function decode(
      value: unknown,
    ) {
      return value;
    }
  `;

  assert.equal(
    digestTypeScriptBehavior(compact),
    digestTypeScriptBehavior(formatted),
  );
});

test('readBaseSnapshot bootstraps only when the snapshot file is absent', async (t) => {
  const { mkdtempSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os');
  const path = await import('node:path');

  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = (cwd) => git(cwd, ['rev-parse', 'HEAD']).trim();
  const initRepo = () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'collab-protocol-compat-'));
    git(cwd, ['init', '-q']);
    git(cwd, ['config', 'user.email', 'test@example.invalid']);
    git(cwd, ['config', 'user.name', 'Test']);
    return cwd;
  };

  await t.test('returns the parsed snapshot when the base commit contains it', () => {
    const cwd = initRepo();
    const relative = 'packages/collab-protocol/contract-snapshot.json';
    const file = path.join(cwd, relative);
    execFileSync('mkdir', ['-p', path.dirname(file)]);
    execFileSync('sh', ['-c', `printf '%s' '{"schemaVersion":1,"marker":"base"}' > "$1"`, 'sh', file]);
    git(cwd, ['add', relative]);
    git(cwd, ['commit', '-q', '-m', 'with snapshot']);

    const base = readBaseSnapshot(commit(cwd), { cwd });
    assert.equal(base.marker, 'base');
  });

  await t.test('returns null when the base commit lacks the snapshot file', () => {
    const cwd = initRepo();
    execFileSync('sh', ['-c', 'printf x > README && git add README && git commit -q -m init'], { cwd });

    assert.equal(readBaseSnapshot(commit(cwd), { cwd }), null);
  });

  await t.test('throws when the base commit is unavailable', () => {
    const cwd = initRepo();
    execFileSync('sh', ['-c', 'printf x > README && git add README && git commit -q -m init'], { cwd });

    assert.throws(
      () => readBaseSnapshot('0000000000000000000000000000000000000000', { cwd }),
      /Cannot read the base protocol contract snapshot/u,
    );
  });

  await t.test('throws when the base snapshot is malformed JSON', () => {
    const cwd = initRepo();
    const relative = 'packages/collab-protocol/contract-snapshot.json';
    const file = path.join(cwd, relative);
    execFileSync('mkdir', ['-p', path.dirname(file)]);
    execFileSync('sh', ['-c', 'printf %s "not json" > "$1"', 'sh', file]);
    git(cwd, ['add', relative]);
    git(cwd, ['commit', '-q', '-m', 'malformed snapshot']);

    assert.throws(
      () => readBaseSnapshot(commit(cwd), { cwd }),
      /Cannot parse the base protocol contract snapshot/u,
    );
  });
});
