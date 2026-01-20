/**
 * Migration Constants - Shared constants for storage migration.
 *
 * Single source of truth for fields that need to be migrated
 * from settings.json to claudian-settings.json.
 */

/**
 * Fields that are Claudian-specific and should NOT be in CC settings.json.
 * These are migrated to claudian-settings.json and stripped from settings.json.
 *
 * IMPORTANT: Keep this list updated when adding new Claudian settings!
 */
export const CLAUDIAN_ONLY_FIELDS = new Set([
  // User preferences
  'userName',

  // Security settings
  'enableBlocklist',
  'blockedCommands',
  'permissionMode',
  'lastNonPlanPermissionMode',

  // Model & thinking
  'model',
  'thinkingBudget',
  'enableAutoTitleGeneration',
  'titleGenerationModel',

  // Content settings
  'excludedTags',
  'mediaFolder',
  'systemPrompt',
  'allowedExportPaths',
  'persistentExternalContextPaths',

  // Environment (Claudian uses string format + snippets)
  'environmentVariables',
  'envSnippets',

  // UI settings
  'keyboardNavigation',

  // CLI paths
  'claudeCliPath',
  'claudeCliPaths',
  'loadUserClaudeSettings',

  // Deprecated fields (removed completely, not migrated)
  'allowedContextPaths',
  'showToolUse',
  'toolCallExpandedByDefault',
]);

/**
 * Fields that are Claudian-specific and should be migrated.
 * Excludes deprecated fields which are just removed.
 */
export const MIGRATABLE_CLAUDIAN_FIELDS = new Set([
  'userName',
  'enableBlocklist',
  'blockedCommands',
  'permissionMode',
  'lastNonPlanPermissionMode',
  'model',
  'thinkingBudget',
  'enableAutoTitleGeneration',
  'titleGenerationModel',
  'excludedTags',
  'mediaFolder',
  'systemPrompt',
  'allowedExportPaths',
  'persistentExternalContextPaths',
  'environmentVariables',
  'envSnippets',
  'env', // Converted to environmentVariables
  'keyboardNavigation',
  'claudeCliPath',
  'claudeCliPaths',
  'loadUserClaudeSettings',
]);

/**
 * Deprecated fields that are removed completely (not migrated).
 */
export const DEPRECATED_FIELDS = new Set([
  'allowedContextPaths',
  'showToolUse',
  'toolCallExpandedByDefault',
]);

/**
 * Convert CC env object format to Claudian environmentVariables string format.
 *
 * @example
 * { ANTHROPIC_API_KEY: "xxx", MY_VAR: "value" }
 * → "ANTHROPIC_API_KEY=xxx\nMY_VAR=value"
 */
export function convertEnvObjectToString(env: Record<string, string> | undefined): string {
  if (!env || typeof env !== 'object') {
    return '';
  }

  return Object.entries(env)
    .filter(([key, value]) => typeof key === 'string' && typeof value === 'string')
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

/**
 * Merge two environmentVariables strings, removing duplicates.
 * Later values override earlier ones for the same key.
 */
export function mergeEnvironmentVariables(existing: string, additional: string): string {
  const envMap = new Map<string, string>();

  // Parse existing
  for (const line of existing.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex > 0) {
      const key = trimmed.slice(0, eqIndex);
      const value = trimmed.slice(eqIndex + 1);
      envMap.set(key, value);
    }
  }

  // Parse additional (overrides existing)
  for (const line of additional.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex > 0) {
      const key = trimmed.slice(0, eqIndex);
      const value = trimmed.slice(eqIndex + 1);
      envMap.set(key, value);
    }
  }

  return Array.from(envMap.entries())
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}
