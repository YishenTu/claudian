import { t } from '@/i18n/i18n';
import type { TranslationKey } from '@/i18n/types';

import type { ProviderPermissionModeOption, ProviderPermissionModePolicy } from './types';

/** One permission mode a provider offers, defined once for its stored policy and its toolbar menu. */
export interface ProviderPermissionModeDefinition {
  readonly value: string;
  /** Mode names are English in every locale. */
  readonly label: string;
  /** Literal text, or a translation key resolved for the current locale. */
  readonly description: string | { readonly key: TranslationKey };
  /** Skips approval prompts. */
  readonly bypassesApprovals?: true;
}

/** A policy whose stored values are the definitions' values, in menu order. */
export function createPermissionModePolicy(
  definitions: readonly ProviderPermissionModeDefinition[],
  policy: Omit<ProviderPermissionModePolicy, 'values'>,
): ProviderPermissionModePolicy {
  return Object.freeze({ ...policy, values: Object.freeze(definitions.map(definition => definition.value)) });
}

/** Menu options in definition order; keyed descriptions are translated on every call. */
export function buildPermissionModeOptions(
  definitions: readonly ProviderPermissionModeDefinition[],
): ProviderPermissionModeOption[] {
  return definitions.map(({ value, label, description, bypassesApprovals }) => ({
    value,
    label,
    description: typeof description === 'string' ? description : t(description.key),
    ...(bypassesApprovals ? { bypassesApprovals } : {}),
  }));
}

/**
 * The mode a provider runs and displays for a stored or selected value: a known value, a migrated
 * retired one, else the policy's fail-closed fallback. Without a policy the value passes through.
 */
export function resolvePermissionMode(
  policy: ProviderPermissionModePolicy | undefined,
  value: unknown,
  settings: Record<string, unknown>,
): string {
  if (!policy) return typeof value === 'string' ? value : '';
  if (typeof value === 'string' && policy.values.includes(value)) return value;
  const migrated = typeof value === 'string' ? policy.migrateValue?.(value, settings) : undefined;
  return migrated !== undefined && policy.values.includes(migrated) ? migrated : policy.fallbackValue;
}
