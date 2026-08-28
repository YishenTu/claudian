import * as fs from 'fs';
import * as path from 'path';

import { resolveClaudeConfigDir } from '../config/ClaudeConfigDir';
import { CLAUDE_MODEL_ENV_KEYS } from './claudeModelEnv';

/**
 * Model-related environment read from the user-level Claude Code settings file
 * (the file CC Switch and the Claude Code CLI rewrite when the provider or
 * model changes). Claudian only reads this file; it never modifies it.
 */
export interface ClaudeUserSettingsModelEnvironment {
  /** Model selection env vars (ANTHROPIC_MODEL / ANTHROPIC_DEFAULT_*_MODEL). */
  env: Record<string, string>;
  /** Display names (ANTHROPIC_DEFAULT_*_MODEL_NAME) keyed by their model id. */
  displayNames: Record<string, string>;
}

const EMPTY_ENVIRONMENT: ClaudeUserSettingsModelEnvironment = {
  env: {},
  displayNames: {},
};

/**
 * Extract the model-related env block of a Claude Code settings file.
 * Only model selection keys and their display-name counterparts are read;
 * auth tokens and other secrets never leave this function.
 */
export function readClaudeUserSettingsModelFile(
  filePath: string,
): ClaudeUserSettingsModelEnvironment {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { ...EMPTY_ENVIRONMENT };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY_ENVIRONMENT };
  }

  const record = parsed as { env?: Record<string, unknown> } | null;
  const env = record && typeof record === 'object' && record.env
    && typeof record.env === 'object' && !Array.isArray(record.env)
    ? record.env
    : {};
  const result: Record<string, string> = {};
  const displayNames: Record<string, string> = {};

  for (const envKey of CLAUDE_MODEL_ENV_KEYS) {
    const value = env[envKey];
    if (typeof value !== 'string' || value.length === 0) {
      continue;
    }
    result[envKey] = value;
    if (envKey === 'ANTHROPIC_MODEL') {
      continue;
    }
    const name = env[envKey + '_NAME'];
    if (typeof name === 'string' && name.length > 0) {
      displayNames[value] = name;
    }
  }

  return { env: result, displayNames };
}

/**
 * Resolve the user-level Claude Code settings file and read its model
 * environment. The file is read live on each call (it is a few KB) so
 * provider switches made through CC Switch are reflected without a plugin
 * restart. Test runs are skipped so unit tests stay hermetic.
 */
export function getClaudeUserSettingsModelEnvironment(
  configDir?: string,
): ClaudeUserSettingsModelEnvironment {
  if (process.env.NODE_ENV === 'test') {
    return { ...EMPTY_ENVIRONMENT };
  }
  const directory = configDir ?? resolveClaudeConfigDir();
  return readClaudeUserSettingsModelFile(path.join(directory, 'settings.json'));
}
