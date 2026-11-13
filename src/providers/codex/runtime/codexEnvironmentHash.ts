import { createEnvironmentRuntimeInputFingerprint } from '../../../core/providers/settings/RuntimeInputFingerprint';

/** Fingerprint of the whole configured environment plus launch inputs; a change restarts the app-server. */
export function computeCodexEnvHash(
  environmentText: string,
  additionalInputs: Readonly<Record<string, string | undefined>> = {},
): string {
  return createEnvironmentRuntimeInputFingerprint(environmentText, additionalInputs);
}
