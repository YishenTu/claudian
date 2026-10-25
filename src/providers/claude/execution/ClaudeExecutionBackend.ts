import type {
  ProviderExecutionBackend,
  ProviderSessionConfig,
} from '../../../core/execution';
import type { ProviderRuntimeHost } from '../../../core/providers/ProviderRuntimeHost';
import { ClaudeExecutionSession, type ClaudeExecutionSessionOptions } from './ClaudeExecutionSession';

export class ClaudeExecutionBackend implements ProviderExecutionBackend {
  readonly providerId = 'claude' as const;

  constructor(
    private readonly host: ProviderRuntimeHost,
    private readonly options: ClaudeExecutionSessionOptions = {},
  ) {}

  createSession(config: ProviderSessionConfig): ClaudeExecutionSession {
    return new ClaudeExecutionSession(
      this.host,
      config,
      this.options,
    );
  }
}
