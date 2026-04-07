import { parseEnvironmentVariables } from '../../utils/env';
import { getProviderConfig, setProviderConfig } from './providerConfig';
import { ProviderRegistry } from './ProviderRegistry';
import type { ProviderId } from './types';

export type EnvironmentScope = 'shared' | `provider:${string}`;
export interface EnvironmentScopeUpdate {
  scope: EnvironmentScope;
  envText: string;
}

type EnvironmentKeyOwnership =
  | { type: 'shared-known' }
  | { type: 'shared-unknown' }
  | { type: 'provider'; providerId: ProviderId };

interface ClassifiedEnvironmentLines {
  shared: string[];
  providers: Partial<Record<ProviderId, string[]>>;
  reviewKeys: Set<string>;
}

const SHARED_ENVIRONMENT_KEYS = new Set([
  'PATH',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'NODE_EXTRA_CA_CERTS',
  'TMPDIR',
  'TMP',
  'TEMP',
]);

function resolveScopeProviderId(scope: EnvironmentScope): ProviderId | null {
  return scope.startsWith('provider:') ? scope.slice('provider:'.length) : null;
}

function classifyEnvironmentKey(key: string): EnvironmentKeyOwnership {
  const normalized = key.trim().toUpperCase();
  if (!normalized) {
    return { type: 'shared-unknown' };
  }

  if (SHARED_ENVIRONMENT_KEYS.has(normalized)) {
    return { type: 'shared-known' };
  }

  for (const providerId of ProviderRegistry.getRegisteredProviderIds()) {
    const patterns = ProviderRegistry.getEnvironmentKeyPatterns(providerId);
    if (patterns.some((pattern) => pattern.test(normalized))) {
      return { type: 'provider', providerId };
    }
  }

  return { type: 'shared-unknown' };
}

function extractEnvironmentKey(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }

  const normalized = trimmed.startsWith('export ') ? trimmed.slice(7) : trimmed;
  const eqIndex = normalized.indexOf('=');
  if (eqIndex <= 0) {
    return null;
  }

  const key = normalized.slice(0, eqIndex).trim();
  return key || null;
}

function appendLines(target: string[], pendingDecorators: string[], line: string): void {
  target.push(...pendingDecorators, line);
}

function createClassifiedEnvironmentLines(): ClassifiedEnvironmentLines {
  return {
    shared: [],
    providers: {},
    reviewKeys: new Set<string>(),
  };
}

function joinEnvironmentLines(lines: string[]): string {
  return lines.join('\n');
}

function hasMeaningfulEnvironmentContent(envText: string): boolean {
  return envText
    .split(/\r?\n/)
    .some((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith('#');
    });
}

function getLegacyEnvironmentClassification(
  settings: Record<string, unknown>,
): ReturnType<typeof classifyEnvironmentVariablesByOwnership> {
  const legacyEnvironmentVariables = settings.environmentVariables;
  if (typeof legacyEnvironmentVariables !== 'string' || legacyEnvironmentVariables.length === 0) {
    return {
      shared: '',
      providers: {},
      reviewKeys: [],
    };
  }

  return classifyEnvironmentVariablesByOwnership(legacyEnvironmentVariables);
}

export function classifyEnvironmentVariablesByOwnership(input: string): {
  shared: string;
  providers: Partial<Record<ProviderId, string>>;
  reviewKeys: string[];
} {
  const result = createClassifiedEnvironmentLines();
  let pendingDecorators: string[] = [];

  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      pendingDecorators.push(line);
      continue;
    }

    const key = extractEnvironmentKey(line);
    if (!key) {
      appendLines(result.shared, pendingDecorators, line);
      pendingDecorators = [];
      continue;
    }

    const ownership = classifyEnvironmentKey(key);
    if (ownership.type === 'provider') {
      const target = result.providers[ownership.providerId] ?? [];
      appendLines(target, pendingDecorators, line);
      result.providers[ownership.providerId] = target;
    } else {
      appendLines(result.shared, pendingDecorators, line);
      if (ownership.type === 'shared-unknown') {
        result.reviewKeys.add(key);
      }
    }
    pendingDecorators = [];
  }

  if (pendingDecorators.length > 0) {
    result.shared.push(...pendingDecorators);
  }

  return {
    shared: joinEnvironmentLines(result.shared),
    providers: Object.fromEntries(
      Object.entries(result.providers).map(([providerId, lines]) => [
        providerId,
        joinEnvironmentLines(lines ?? []),
      ]),
    ),
    reviewKeys: Array.from(result.reviewKeys),
  };
}

export function getSharedEnvironmentVariables(settings: Record<string, unknown>): string {
  const sharedEnvironmentVariables = settings.sharedEnvironmentVariables;
  if (typeof sharedEnvironmentVariables === 'string') {
    return sharedEnvironmentVariables;
  }

  return getLegacyEnvironmentClassification(settings).shared;
}

export function setSharedEnvironmentVariables(
  settings: Record<string, unknown>,
  envText: string,
): void {
  settings.sharedEnvironmentVariables = envText;
  delete settings.environmentVariables;
}

export function getProviderEnvironmentVariables(
  settings: Record<string, unknown>,
  providerId: ProviderId,
): string {
  const providerConfig = getProviderConfig(settings, providerId);
  if (typeof providerConfig.environmentVariables === 'string') {
    return providerConfig.environmentVariables;
  }

  return getLegacyEnvironmentClassification(settings).providers[providerId] ?? '';
}

export function setProviderEnvironmentVariables(
  settings: Record<string, unknown>,
  providerId: ProviderId,
  envText: string,
): void {
  setProviderConfig(settings, providerId, {
    ...getProviderConfig(settings, providerId),
    environmentVariables: envText,
  });
  delete settings.environmentVariables;
}

export function joinEnvironmentTexts(...parts: Array<string | undefined>): string {
  const filtered = parts.filter((part): part is string => typeof part === 'string' && part.length > 0);
  if (filtered.length === 0) {
    return '';
  }

  return filtered.reduce((combined, part) => {
    if (!combined) {
      return part;
    }

    return combined.endsWith('\n') ? `${combined}${part}` : `${combined}\n${part}`;
  }, '');
}

export function getRuntimeEnvironmentText(
  settings: Record<string, unknown>,
  providerId: ProviderId,
): string {
  return joinEnvironmentTexts(
    getSharedEnvironmentVariables(settings),
    getProviderEnvironmentVariables(settings, providerId),
  );
}

export function getRuntimeEnvironmentVariables(
  settings: Record<string, unknown>,
  providerId: ProviderId,
): Record<string, string> {
  return parseEnvironmentVariables(getRuntimeEnvironmentText(settings, providerId));
}

export function getEnvironmentVariablesForScope(
  settings: Record<string, unknown>,
  scope: EnvironmentScope,
): string {
  if (scope === 'shared') {
    return getSharedEnvironmentVariables(settings);
  }

  return getProviderEnvironmentVariables(settings, resolveScopeProviderId(scope) ?? '');
}

export function setEnvironmentVariablesForScope(
  settings: Record<string, unknown>,
  scope: EnvironmentScope,
  envText: string,
): void {
  if (scope === 'shared') {
    setSharedEnvironmentVariables(settings, envText);
    return;
  }

  const providerId = resolveScopeProviderId(scope);
  if (!providerId) {
    return;
  }

  setProviderEnvironmentVariables(settings, providerId, envText);
}

export function getEnvironmentReviewKeysForScope(
  envText: string,
  scope: EnvironmentScope,
): string[] {
  const reviewKeys = new Set<string>();
  const expectedProviderId = resolveScopeProviderId(scope);

  for (const line of envText.split(/\r?\n/)) {
    const key = extractEnvironmentKey(line);
    if (!key || reviewKeys.has(key)) {
      continue;
    }

    const ownership = classifyEnvironmentKey(key);
    if (scope === 'shared') {
      if (ownership.type !== 'shared-known') {
        reviewKeys.add(key);
      }
      continue;
    }

    if (ownership.type !== 'provider' || ownership.providerId !== expectedProviderId) {
      reviewKeys.add(key);
    }
  }

  return Array.from(reviewKeys);
}

export function inferEnvironmentSnippetScope(
  envText: string,
): EnvironmentScope | undefined {
  const classified = classifyEnvironmentVariablesByOwnership(envText);
  const nonEmptyScopes: EnvironmentScope[] = [];

  if (hasMeaningfulEnvironmentContent(classified.shared)) {
    nonEmptyScopes.push('shared');
  }

  for (const [providerId, providerEnv] of Object.entries(classified.providers)) {
    if (providerEnv && hasMeaningfulEnvironmentContent(providerEnv)) {
      nonEmptyScopes.push(`provider:${providerId}`);
    }
  }

  return nonEmptyScopes.length === 1 ? nonEmptyScopes[0] : undefined;
}

export function resolveEnvironmentSnippetScope(
  envText: string,
  fallbackScope?: EnvironmentScope,
): EnvironmentScope | undefined {
  const inferredScope = inferEnvironmentSnippetScope(envText);
  if (inferredScope) {
    return inferredScope;
  }

  return hasMeaningfulEnvironmentContent(envText) ? undefined : fallbackScope;
}

export function getEnvironmentScopeUpdates(
  envText: string,
  fallbackScope?: EnvironmentScope,
): EnvironmentScopeUpdate[] {
  const classified = classifyEnvironmentVariablesByOwnership(envText);
  const updates: EnvironmentScopeUpdate[] = [];

  if (classified.shared.trim()) {
    updates.push({ scope: 'shared', envText: classified.shared });
  }

  for (const [providerId, providerEnv] of Object.entries(classified.providers)) {
    if (!providerEnv || !providerEnv.trim()) {
      continue;
    }

    updates.push({
      scope: `provider:${providerId}`,
      envText: providerEnv,
    });
  }

  if (updates.length > 0) {
    return updates;
  }

  if (fallbackScope) {
    return [{ scope: fallbackScope, envText }];
  }

  return [];
}
