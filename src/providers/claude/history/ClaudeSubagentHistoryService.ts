import { parseEnvironmentVariables } from '@/core/process/env';

import type { ProviderRuntimeHost } from '../../../core/providers/ProviderRuntimeHost';
import type {
  ProviderHistoryEnvironment,
  ProviderSubagentHistoryRequest,
  ProviderSubagentHistoryService,
} from '../../../core/providers/types';
import {
  loadSubagentFinalResult,
  loadSubagentToolCalls,
} from './ClaudeHistoryStore';

export class ClaudeSubagentHistoryService implements ProviderSubagentHistoryService {
  constructor(private readonly host: Pick<ProviderRuntimeHost, 'environmentText'>) {}

  loadToolCalls(request: ProviderSubagentHistoryRequest) {
    return loadSubagentToolCalls(
      request.vaultPath,
      request.providerSessionId,
      request.subagentId,
      undefined,
      this.#buildPathContext(request.vaultPath),
    );
  }

  loadFinalResult(request: ProviderSubagentHistoryRequest) {
    return loadSubagentFinalResult(
      request.vaultPath,
      request.providerSessionId,
      request.subagentId,
      undefined,
      this.#buildPathContext(request.vaultPath),
    );
  }

  #buildPathContext(vaultPath: string): ProviderHistoryEnvironment {
    const customEnvironment = parseEnvironmentVariables(this.host.environmentText);
    return {
      environment: { ...process.env, ...customEnvironment },
      hostPlatform: process.platform,
      vaultPath,
    };
  }
}
