import { createHash } from 'node:crypto';
import path from 'node:path';

export const AGENT_RUNTIME_PORT_MIN = 49_152;
export const AGENT_RUNTIME_PORT_COUNT = 16_384;
export const AGENT_RUNTIME_MAX_PORT_CANDIDATES = 64;

const AGENT_RUNTIME_PORT_NAMESPACE = 'claudian-agent-runtime:v1:';

export interface AgentRuntimePortCandidateOptions {
  readonly maxCandidates?: number;
  readonly platform?: NodeJS.Platform;
}

export function deriveAgentRuntimePortCandidates(
  vaultPath: string,
  options: AgentRuntimePortCandidateOptions = {},
): readonly number[] {
  if (!vaultPath.trim()) throw new Error('Vault path must not be blank.');
  const maxCandidates = options.maxCandidates ?? AGENT_RUNTIME_MAX_PORT_CANDIDATES;
  if (
    !Number.isInteger(maxCandidates)
    || maxCandidates < 1
    || maxCandidates > AGENT_RUNTIME_PORT_COUNT
  ) {
    throw new Error(
      `Agent Runtime candidate count must be between 1 and ${AGENT_RUNTIME_PORT_COUNT}.`,
    );
  }

  const normalizedPath = normalizeVaultPath(vaultPath, options.platform ?? process.platform);
  const digest = createHash('sha256')
    .update(`${AGENT_RUNTIME_PORT_NAMESPACE}${normalizedPath}`, 'utf8')
    .digest();
  const initialOffset = digest.readUInt32BE(0) % AGENT_RUNTIME_PORT_COUNT;
  const probeStep = ((digest.readUInt32BE(4) | 1) >>> 0) % AGENT_RUNTIME_PORT_COUNT;

  return Array.from({ length: maxCandidates }, (_, index) => (
    AGENT_RUNTIME_PORT_MIN
    + ((initialOffset + (index * probeStep)) % AGENT_RUNTIME_PORT_COUNT)
  ));
}

function normalizeVaultPath(vaultPath: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return path.win32
      .resolve(vaultPath)
      .normalize('NFC')
      .replaceAll('\\', '/')
      .toLocaleLowerCase('en-US');
  }
  return path.posix.resolve(vaultPath).normalize('NFC');
}
