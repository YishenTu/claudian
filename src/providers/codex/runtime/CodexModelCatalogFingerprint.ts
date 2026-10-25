/**
 * Cache fingerprint for the Codex model catalog.
 *
 * The fingerprint captures the inputs that affect which models the Codex
 * app-server will report. When any input changes, the cached catalog is
 * considered stale and will be refreshed.
 */

import { createHash } from 'node:crypto';

import type { ProviderRuntimeHost } from '../../../core/providers/ProviderRuntimeHost';
import type { ProviderTransitionOwnerContext } from '../../../core/providers/types';
import { decodeCodexConfig } from '../config';
import { computeCodexEnvHash } from './codexEnvironmentHash';
import { resolveCodexExecutionTargetAsync } from './CodexExecutionTargetResolver';

const CATALOG_FINGERPRINT_VERSION = '2';

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

export async function computeCodexCatalogFingerprint(
  host: ProviderRuntimeHost,
  context?: ProviderTransitionOwnerContext,
): Promise<string> {
  // Read before awaiting so the fingerprint describes one configuration.
  const envText = host.environmentText;
  const hostVaultPath = host.workingDirectory;
  const executionTarget = await resolveCodexExecutionTargetAsync({
    codexSettings: decodeCodexConfig(host.config),
    hostVaultPath,
  });
  const resolvedCliCommand = await host.resolveCliPath({
    ...context,
    executionTarget,
  });
  const executionTargetKey = [
    executionTarget.method,
    executionTarget.platformFamily,
    executionTarget.platformOs,
    executionTarget.distroName ?? '',
  ].join(':');
  const envHash = computeCodexEnvHash(envText);

  return buildCodexCatalogFingerprint({
    resolvedCliCommand,
    executionTargetKey,
    envHash,
  });
}
