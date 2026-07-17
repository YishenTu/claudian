import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderHistoryPathContext } from '../../../core/providers/types';
import { parseEnvironmentVariables } from '../../../utils/env';
import { getGrokState } from '../types';

export function getGrokHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GROK_HOME?.trim();
  if (override) {
    return override;
  }
  return path.join(os.homedir(), '.grok');
}

export function encodeGrokSessionCwd(vaultPath: string): string {
  return encodeURIComponent(vaultPath);
}

/**
 * Resolve Grok home for history hydration.
 *
 * Order: persisted providerState.grokHome → pathContext env/settings → process.env → default.
 */
export function resolveGrokHomeForHistory(
  conversation: {
    providerState?: Record<string, unknown>;
  } | null | undefined,
  pathContext?: ProviderHistoryPathContext,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const stateHome = getGrokState(conversation?.providerState).grokHome;
  if (stateHome) {
    return stateHome;
  }

  const contextEnvHome = pathContext?.environment?.GROK_HOME?.trim();
  if (contextEnvHome) {
    return contextEnvHome;
  }

  if (pathContext?.settings) {
    const envText = getRuntimeEnvironmentText(pathContext.settings, 'grok');
    const vars = parseEnvironmentVariables(envText);
    const settingsHome = vars.GROK_HOME?.trim();
    if (settingsHome) {
      return settingsHome;
    }
  }

  return getGrokHome(env);
}

export function resolveGrokHistoryFile(
  vaultPath: string | null | undefined,
  sessionId: string | null | undefined,
  options: {
    env?: NodeJS.ProcessEnv;
    grokHome?: string | null;
  } = {},
): string | null {
  if (!vaultPath || !sessionId) {
    return null;
  }

  const grokHome = options.grokHome?.trim() || getGrokHome(options.env ?? process.env);
  const historyPath = path.join(
    grokHome,
    'sessions',
    encodeGrokSessionCwd(vaultPath),
    sessionId,
    'chat_history.jsonl',
  );

  try {
    return fs.statSync(historyPath).isFile() ? historyPath : null;
  } catch {
    return null;
  }
}

export function resolveLatestGrokHistoryFile(
  vaultPath: string | null | undefined,
  afterMtimeMs = 0,
  options: {
    env?: NodeJS.ProcessEnv;
    grokHome?: string | null;
  } = {},
): { historyPath: string; mtimeMs: number; sessionId: string } | null {
  if (!vaultPath) {
    return null;
  }

  const grokHome = options.grokHome?.trim() || getGrokHome(options.env ?? process.env);
  const sessionsRoot = path.join(
    grokHome,
    'sessions',
    encodeGrokSessionCwd(vaultPath),
  );

  let best: { historyPath: string; mtimeMs: number; sessionId: string } | null = null;
  try {
    for (const sessionId of fs.readdirSync(sessionsRoot)) {
      const historyPath = path.join(sessionsRoot, sessionId, 'chat_history.jsonl');
      let stat: fs.Stats;
      try {
        stat = fs.statSync(historyPath);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.mtimeMs < afterMtimeMs) {
        continue;
      }
      if (!best || stat.mtimeMs > best.mtimeMs) {
        best = { historyPath, mtimeMs: stat.mtimeMs, sessionId };
      }
    }
  } catch {
    return null;
  }

  return best;
}
