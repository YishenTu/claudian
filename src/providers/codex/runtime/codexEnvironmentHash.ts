import { parseEnvironmentVariables } from '@/core/process/env';
import type { InstallationSettings } from '@/core/providers/settings/InstallationSettings';

import { createRuntimeInputFingerprint } from '../../../core/providers/settings/RuntimeInputFingerprint';

export const LEGACY_CODEX_ENV_HASH_KEYS = [
  'OPENAI_MODEL',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
] as const;
const NATIVE_HOME_ENV_KEYS = ['CODEX_HOME', 'HOME', 'USERPROFILE'];
export const CODEX_ENV_HASH_KEYS = [...LEGACY_CODEX_ENV_HASH_KEYS, 'PATH', ...NATIVE_HOME_ENV_KEYS];
/**
 * Inputs that select the rollout store, endpoint, or account. CLI paths, `PATH`, and
 * `OPENAI_MODEL` only affect the launched process, so their changes keep thread bindings.
 */
const SESSION_ENV_HASH_KEYS = ['OPENAI_BASE_URL', 'OPENAI_API_KEY', ...NATIVE_HOME_ENV_KEYS];

export type CodexInstallationInputs = InstallationSettings;

/** Keeps existing default-home fingerprints stable when no override is configured. */
function withConfiguredHomeKeys(keys: readonly string[], environmentText: string): string[] {
  const environment = parseEnvironmentVariables(environmentText);
  return keys.filter(key => (
    !NATIVE_HOME_ENV_KEYS.includes(key) || Object.prototype.hasOwnProperty.call(environment, key)
  ));
}

export function computeCodexEnvHash(
  environmentText: string,
  additionalInputs: Readonly<Record<string, string | undefined>> = {},
): string {
  return createRuntimeInputFingerprint({
    additionalInputs,
    environmentKeys: withConfiguredHomeKeys(CODEX_ENV_HASH_KEYS, environmentText),
    environmentText,
  });
}

export function computeCodexSessionEnvHash(
  environmentText: string,
  installation: CodexInstallationInputs,
): string {
  return createRuntimeInputFingerprint({
    additionalInputs: { ...installation },
    environmentKeys: withConfiguredHomeKeys(SESSION_ENV_HASH_KEYS, environmentText),
    environmentText,
  });
}
