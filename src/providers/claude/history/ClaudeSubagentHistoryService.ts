import { parseEnvironmentVariables } from '@/core/process/env';

import type { ProviderRuntimeHost } from '../../../core/providers/ProviderRuntimeHost';
import type {
  ProviderSubagentHistoryRequest,
  ProviderSubagentHistoryService,
} from '../../../core/providers/types';
import type { ClaudeConfigDirContext } from '../config/ClaudeConfigDir';
import { resolveClaudeHistoryContext } from './ClaudeHistoryContext';
import {
  loadSubagentFinalResult,
  loadSubagentToolCalls,
} from './ClaudeHistoryStore';

export class ClaudeSubagentHistoryService implements ProviderSubagentHistoryService {
  constructor(private readonly host: Pick<ProviderRuntimeHost, 'environmentText' | 'config'>) {}

  async loadToolCalls(request: ProviderSubagentHistoryRequest) {
    return loadSubagentToolCalls(
      request.vaultPath,
      request.providerSessionId,
      request.subagentId,
      undefined,
      await resolveClaudeHistoryContext(this.#buildPathContext(request.vaultPath), request.vaultPath),
    );
  }

  async loadFinalResult(request: ProviderSubagentHistoryRequest) {
    return loadSubagentFinalResult(
      request.vaultPath,
      request.providerSessionId,
      request.subagentId,
      undefined,
      await resolveClaudeHistoryContext(this.#buildPathContext(request.vaultPath), request.vaultPath),
    );
  }

  #buildPathContext(vaultPath: string): ClaudeConfigDirContext {
    const customEnvironment = parseEnvironmentVariables(this.host.environmentText);
    return {
      config: this.host.config,
      environmentText: this.host.environmentText,
      environment: { ...process.env, ...customEnvironment },
      hostPlatform: process.platform,
      vaultPath,
    };
  }
}
