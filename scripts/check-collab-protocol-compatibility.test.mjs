import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertVersionedContractChange,
  digestTypeScriptBehavior,
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
