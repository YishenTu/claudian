import { createHash } from 'node:crypto';

import { parseEnvironmentVariables } from '@/core/process/env';
import type { ProviderEnvironmentSessionPolicy } from '@/core/providers/types';

export const RUNTIME_INPUT_FINGERPRINT_VERSION = 1;

const FINGERPRINT_PREFIX = `runtime-input:v${RUNTIME_INPUT_FINGERPRINT_VERSION}:`;
const MISSING_VALUE = Object.freeze({ missing: true });

export interface RuntimeInputFingerprintOptions {
  additionalInputs?: Readonly<Record<string, string | undefined>>;
  environmentKeys: readonly string[];
  environmentText: string;
}

export function createRuntimeInputFingerprint(
  options: RuntimeInputFingerprintOptions,
): string {
  const environment = parseEnvironmentVariables(options.environmentText || '');
  const environmentEntries = Array.from(new Set(
    options.environmentKeys.map(key => key.trim()).filter(Boolean),
  ))
    .sort((left, right) => left.localeCompare(right))
    .map(key => [
      key,
      Object.prototype.hasOwnProperty.call(environment, key)
        ? environment[key]
        : MISSING_VALUE,
    ] as const);
  const additionalEntries = Object.entries(options.additionalInputs ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, value === undefined ? MISSING_VALUE : value] as const);
  const canonicalInput = JSON.stringify({
    additionalInputs: additionalEntries,
    environment: environmentEntries,
    version: RUNTIME_INPUT_FINGERPRINT_VERSION,
  });
  const digest = createHash('sha256').update(canonicalInput, 'utf8').digest('hex');
  return `${FINGERPRINT_PREFIX}${digest}`;
}

export function isVersionedRuntimeInputFingerprint(value: unknown): boolean {
  return typeof value === 'string'
    && new RegExp(`^${FINGERPRINT_PREFIX}[0-9a-f]{64}$`).test(value);
}

export interface ScopedRuntimeInputFingerprints {
  /** Every runtime input; a change requires a new native runtime. */
  runtime: string;
  /** Inputs that select the native session store, endpoint, or account; a change invalidates bindings. */
  session: string;
}

/** The provider's persisted `environmentHash` and `sessionEnvironmentHash`. */
export interface SavedScopedRuntimeInputFingerprints {
  readonly environmentHash: string;
  readonly sessionEnvironmentHash: string;
}

export interface ScopedRuntimeInputChange {
  changed: boolean;
  /** Meaningful only when changed: what the change does to conversation bindings. */
  sessionPolicy: ProviderEnvironmentSessionPolicy;
}

/**
 * The scoped-fingerprint protocol shared by providers. A blank runtime fingerprint is saved
 * only while no input is configured, so it compares against `emptySessionFingerprint`. A blank
 * session fingerprint beside a saved runtime predates the split: it is backfilled while runtime
 * inputs are unchanged, and any runtime change invalidates because its scope is unknown.
 * Callers persist `current` as the new saved fingerprints when the result is changed.
 */
export function compareScopedRuntimeInputFingerprints(
  saved: SavedScopedRuntimeInputFingerprints,
  current: ScopedRuntimeInputFingerprints,
  emptySessionFingerprint: string,
): ScopedRuntimeInputChange {
  const savedSession = saved.environmentHash ? saved.sessionEnvironmentHash : emptySessionFingerprint;
  const runtimeChanged = saved.environmentHash !== current.runtime;
  const sessionChanged = savedSession !== current.session;
  const invalidatesSessions = sessionChanged && (savedSession !== '' || runtimeChanged);
  return {
    changed: runtimeChanged || sessionChanged,
    sessionPolicy: invalidatesSessions ? 'invalidate' : 'reload',
  };
}
