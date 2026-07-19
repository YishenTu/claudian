import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderHistoryPathContext } from '../../../core/providers/types';
import { parseEnvironmentVariables } from '../../../utils/env';
import { getKimiState } from '../types';

export function getKimiCodeHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KIMI_CODE_HOME?.trim();
  if (override) {
    return override;
  }
  return path.join(os.homedir(), '.kimi-code');
}

/** Matches Kimi Code's agent-core workdir-key.ts. */
export function encodeKimiWorkDirKey(vaultPath: string): string {
  const normalized = /^[A-Za-z]:[\\/]/.test(vaultPath) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(vaultPath)
    ? path.win32.resolve(vaultPath).replaceAll('\\', '/')
    : path.resolve(vaultPath);
  const name = normalized.slice(normalized.lastIndexOf('/') + 1);
  const slugValue = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
  const slug = !slugValue || slugValue === '.' || slugValue === '..'
    ? 'workspace'
    : slugValue;
  const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  return `wd_${slug}_${hash}`;
}

/**
 * Resolve Kimi home for history hydration.
 *
 * Order: persisted providerState.kimiCodeHome → pathContext env/settings → process.env → default.
 */
export function resolveKimiCodeHomeForHistory(
  conversation: {
    providerState?: Record<string, unknown>;
  } | null | undefined,
  pathContext?: ProviderHistoryPathContext,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const stateHome = getKimiState(conversation?.providerState).kimiCodeHome;
  if (stateHome) {
    return stateHome;
  }

  const contextEnvHome = pathContext?.environment?.KIMI_CODE_HOME?.trim();
  if (contextEnvHome) {
    return contextEnvHome;
  }

  if (pathContext?.settings) {
    const envText = getRuntimeEnvironmentText(pathContext.settings, 'kimi');
    const vars = parseEnvironmentVariables(envText);
    const settingsHome = vars.KIMI_CODE_HOME?.trim();
    if (settingsHome) {
      return settingsHome;
    }
  }

  return getKimiCodeHome(env);
}

export function resolveKimiWireHistoryFile(
  vaultPath: string | null | undefined,
  sessionId: string | null | undefined,
  options: {
    env?: NodeJS.ProcessEnv;
    kimiCodeHome?: string | null;
  } = {},
): string | null {
  if (!vaultPath || !isSafeKimiSessionId(sessionId)) {
    return null;
  }

  const kimiCodeHome = options.kimiCodeHome?.trim()
    || getKimiCodeHome(options.env ?? process.env);
  const workDirKey = encodeKimiWorkDirKey(vaultPath);
  const wirePath = path.join(
    kimiCodeHome,
    'sessions',
    workDirKey,
    sessionId,
    'agents',
    'main',
    'wire.jsonl',
  );

  try {
    return fs.statSync(wirePath).isFile() ? wirePath : null;
  } catch {
    return null;
  }
}

/**
 * Scan session_index.jsonl for a session and return its wire.jsonl when present.
 * Falls back to workDirKey path resolution.
 */
export function resolveKimiHistoryFile(
  vaultPath: string | null | undefined,
  sessionId: string | null | undefined,
  options: {
    env?: NodeJS.ProcessEnv;
    kimiCodeHome?: string | null;
  } = {},
): string | null {
  if (!isSafeKimiSessionId(sessionId)) {
    return null;
  }

  const direct = resolveKimiWireHistoryFile(vaultPath, sessionId, options);
  if (direct) {
    return direct;
  }

  const kimiCodeHome = options.kimiCodeHome?.trim()
    || getKimiCodeHome(options.env ?? process.env);
  const indexPath = path.join(kimiCodeHome, 'session_index.jsonl');
  try {
    const content = fs.readFileSync(indexPath, 'utf-8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = typeof record.sessionId === 'string' ? record.sessionId : '';
      const sessionDir = typeof record.sessionDir === 'string' ? record.sessionDir : '';
      if (id !== sessionId || !sessionDir) {
        continue;
      }
      const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
      try {
        if (fs.statSync(wirePath).isFile()) {
          return wirePath;
        }
      } catch {
        // continue
      }
    }
  } catch {
    // index missing
  }

  return null;
}

function isSafeKimiSessionId(sessionId: string | null | undefined): sessionId is string {
  if (!sessionId) {
    return false;
  }
  return !sessionId.includes('/')
    && !sessionId.includes('\\')
    && sessionId !== '.'
    && sessionId !== '..';
}
