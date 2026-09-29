import type {
  ProviderExecutionBackend,
  ProviderSessionConfig,
} from '../../../core/execution';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ClaudeExecutionSession, type ClaudeExecutionSessionOptions } from './ClaudeExecutionSession';

export class ClaudeExecutionBackend implements ProviderExecutionBackend {
  readonly providerId = 'claude' as const;

  constructor(
    private readonly host: ProviderHost,
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
