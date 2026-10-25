import { parseEnvironmentVariables } from '../process/env';
import { getProviderConfig } from './providerConfig';
import { getRuntimeEnvironmentText } from './providerEnvironment';
import type { ProviderHistoryPathContext, ProviderId } from './types';

/** The history path context for one provider, scoped to its own configuration and environment. */
export function createProviderHistoryPathContext(
  settings: Record<string, unknown>,
  providerId: ProviderId,
  vaultPath: string | null,
): ProviderHistoryPathContext {
  const environmentText = getRuntimeEnvironmentText(settings, providerId);
  return {
    config: getProviderConfig(settings, providerId),
    environment: { ...process.env, ...parseEnvironmentVariables(environmentText) },
    environmentText,
    hostPlatform: process.platform,
    vaultPath,
  };
}
