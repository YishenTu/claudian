import type {
  ProviderExecutionBackend,
  ProviderExecutionSession,
  ProviderSessionConfig,
} from '../../../core/execution';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { CodexExecutionSession } from './CodexExecutionSession';

/**
 * Cheap Codex execution entry point. Every created session owns an independent
 * app-server process and native thread lifecycle.
 */
export class CodexExecutionBackend implements ProviderExecutionBackend {
  readonly providerId = 'codex' as const;

  constructor(private readonly plugin: ProviderHost) {}

  createSession(config: ProviderSessionConfig): ProviderExecutionSession {
    return new CodexExecutionSession(this.plugin, config);
  }
}
