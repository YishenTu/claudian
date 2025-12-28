/**
 * Claudian - Environment Utilities
 *
 * Environment variable parsing and model configuration.
 */

/** Parses KEY=VALUE environment variables from text. Supports comments (#) and empty lines. */
export function parseEnvironmentVariables(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  // Handle both Unix (LF) and Windows (CRLF) line endings
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex > 0) {
      const key = trimmed.substring(0, eqIndex).trim();
      let value = trimmed.substring(eqIndex + 1).trim();
      // Strip surrounding quotes (single or double)
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key) {
        result[key] = value;
      }
    }
  }
  return result;
}

/** Extracts model options from ANTHROPIC_* environment variables, deduplicated by value. */
export function getModelsFromEnvironment(envVars: Record<string, string>): { value: string; label: string; description: string }[] {
  const modelMap = new Map<string, { types: string[]; label: string }>();

  const modelEnvEntries: { type: string; envKey: string }[] = [
    { type: 'model', envKey: 'ANTHROPIC_MODEL' },
    { type: 'opus', envKey: 'ANTHROPIC_DEFAULT_OPUS_MODEL' },
    { type: 'sonnet', envKey: 'ANTHROPIC_DEFAULT_SONNET_MODEL' },
    { type: 'haiku', envKey: 'ANTHROPIC_DEFAULT_HAIKU_MODEL' },
  ];

  for (const { type, envKey } of modelEnvEntries) {
    const modelValue = envVars[envKey];
    if (modelValue) {
      const label = modelValue.includes('/')
        ? modelValue.split('/').pop() || modelValue
        : modelValue.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

      if (!modelMap.has(modelValue)) {
        modelMap.set(modelValue, { types: [type], label });
      } else {
        modelMap.get(modelValue)!.types.push(type);
      }
    }
  }

  const models: { value: string; label: string; description: string }[] = [];
  const typePriority = { 'model': 4, 'haiku': 3, 'sonnet': 2, 'opus': 1 };

  const sortedEntries = Array.from(modelMap.entries()).sort(([, aInfo], [, bInfo]) => {
    const aPriority = Math.max(...aInfo.types.map(t => typePriority[t as keyof typeof typePriority] || 0));
    const bPriority = Math.max(...bInfo.types.map(t => typePriority[t as keyof typeof typePriority] || 0));
    return bPriority - aPriority;
  });

  for (const [modelValue, info] of sortedEntries) {
    const sortedTypes = info.types.sort((a, b) =>
      (typePriority[b as keyof typeof typePriority] || 0) -
      (typePriority[a as keyof typeof typePriority] || 0)
    );

    models.push({
      value: modelValue,
      label: info.label,
      description: `Custom model (${sortedTypes.join(', ')})`
    });
  }

  return models;
}

/** Returns the highest-priority custom model from environment variables, or null. */
export function getCurrentModelFromEnvironment(envVars: Record<string, string>): string | null {
  if (envVars.ANTHROPIC_MODEL) {
    return envVars.ANTHROPIC_MODEL;
  }
  if (envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
    return envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  }
  if (envVars.ANTHROPIC_DEFAULT_SONNET_MODEL) {
    return envVars.ANTHROPIC_DEFAULT_SONNET_MODEL;
  }
  if (envVars.ANTHROPIC_DEFAULT_OPUS_MODEL) {
    return envVars.ANTHROPIC_DEFAULT_OPUS_MODEL;
  }
  return null;
}
