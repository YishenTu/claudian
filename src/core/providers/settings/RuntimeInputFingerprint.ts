import { createHash } from 'node:crypto';

import { parseEnvironmentVariables } from '@/core/process/env';

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

export interface RuntimeInputFingerprintChange {
  changed: boolean;
  invalidatesSessions: boolean;
}

/**
 * Compares saved and current scoped fingerprints. A blank saved session fingerprint
 * predates the split: it is backfilled while runtime inputs are unchanged, and any
 * runtime change is treated as session-affecting because its scope is unknown.
 */
export function compareScopedRuntimeInputFingerprints(
  saved: ScopedRuntimeInputFingerprints,
  current: ScopedRuntimeInputFingerprints,
): RuntimeInputFingerprintChange {
  const runtimeChanged = saved.runtime !== current.runtime;
  const sessionChanged = saved.session !== current.session;
  return {
    changed: runtimeChanged || sessionChanged,
    invalidatesSessions: sessionChanged && (saved.session !== '' || runtimeChanged),
  };
}
