/**
 * Cache fingerprint for the Codex model catalog.
 *
 * The fingerprint captures the inputs that affect which models the Codex
 * app-server will report. When any input changes, the cached catalog is
 * considered stale and will be refreshed.
 */

import { createHash } from 'node:crypto';

import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { getVaultPath } from '../../../utils/path';
import { computeCodexEnvHash } from '../env/CodexSettingsReconciler';
import { getCodexProviderSettings } from '../settings';
import { resolveCodexExecutionTargetAsync } from './CodexExecutionTargetResolver';

const CATALOG_FINGERPRINT_VERSION = '1';

export interface CodexCatalogFingerprintInputs {
  resolvedCliCommand: string | null;
  executionTargetKey: string;
  envHash: string;
}

export function buildCodexCatalogFingerprint(
  inputs: CodexCatalogFingerprintInputs,
): string {
  const parts = [
    CATALOG_FINGERPRINT_VERSION,
    inputs.resolvedCliCommand ?? '',
    inputs.executionTargetKey,
    inputs.envHash,
  ];
  return `${CATALOG_FINGERPRINT_VERSION}:${createHash('sha256')
    .update(JSON.stringify(parts))
    .digest('hex')}`;
}

export async function computeCodexCatalogFingerprint(plugin: ProviderHost): Promise<string> {
  const settings = plugin.settings;
  const hostVaultPath = getVaultPath(plugin.app) ?? null;
  const executionTarget = await resolveCodexExecutionTargetAsync({
    settings,
    hostVaultPath,
  });
  const resolvedCliCommand = await plugin.getResolvedProviderCliPath('codex', { executionTarget });
  const executionTargetKey = [
    executionTarget.method,
    executionTarget.platformFamily,
    executionTarget.platformOs,
    executionTarget.distroName ?? '',
  ].join(':');
  const envText = getRuntimeEnvironmentText(settings, 'codex');
  const envHash = computeCodexEnvHash(envText);

  return buildCodexCatalogFingerprint({
    resolvedCliCommand,
    executionTargetKey,
    envHash,
  });
}

export function getCodexCatalogFingerprintFromSettings(
  settings: Record<string, unknown>,
): string {
  return getCodexProviderSettings(settings).catalogFingerprint;
}

export function getCodexCatalogTimestampFromSettings(
  settings: Record<string, unknown>,
): number {
  return getCodexProviderSettings(settings).catalogTimestamp;
}
