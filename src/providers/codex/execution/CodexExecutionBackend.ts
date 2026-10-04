import type {
  ProviderExecutionBackend,
  ProviderExecutionSession,
  ProviderSessionConfig,
} from '../../../core/execution';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { getCodexWorkspaceServices } from '../app/CodexWorkspaceServices';
import type { CodexAppServerRuntime } from '../runtime/CodexAppServerRuntime';
import { CodexExecutionSession } from './CodexExecutionSession';

/**
 * Cheap Codex execution entry point. Sessions own threads on the workspace runtime.
 */
export class CodexExecutionBackend implements ProviderExecutionBackend {
  readonly providerId = 'codex' as const;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly runtime?: CodexAppServerRuntime,
  ) {}

  createSession(config: ProviderSessionConfig): ProviderExecutionSession {
    return new CodexExecutionSession(this.plugin, config, this.runtime ?? getCodexWorkspaceServices().runtime);
  }
}
