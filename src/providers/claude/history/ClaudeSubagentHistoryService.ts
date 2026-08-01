import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type {
  ProviderHistoryPathContext,
  ProviderSubagentHistoryRequest,
  ProviderSubagentHistoryService,
} from '../../../core/providers/types';
import { parseEnvironmentVariables } from '../../../utils/env';
import {
  loadSubagentFinalResult,
  loadSubagentToolCalls,
} from './ClaudeHistoryStore';

export class ClaudeSubagentHistoryService implements ProviderSubagentHistoryService {
  constructor(private readonly host: ProviderHost) {}

  loadToolCalls(request: ProviderSubagentHistoryRequest) {
    return loadSubagentToolCalls(
      request.vaultPath,
      request.providerSessionId,
      request.subagentId,
      undefined,
      this.buildPathContext(request.vaultPath),
    );
  }

  loadFinalResult(request: ProviderSubagentHistoryRequest) {
    return loadSubagentFinalResult(
      request.vaultPath,
      request.providerSessionId,
      request.subagentId,
      undefined,
      this.buildPathContext(request.vaultPath),
    );
  }

  private buildPathContext(vaultPath: string): ProviderHistoryPathContext {
    const customEnvironment = parseEnvironmentVariables(
      this.host.getActiveEnvironmentVariables('claude'),
    );
    return {
      environment: { ...process.env, ...customEnvironment },
      hostPlatform: process.platform,
      settings: ProviderSettingsCoordinator.getProviderSettingsSnapshot(
        this.host.settings,
        'claude',
      ),
      vaultPath,
    };
  }
}
