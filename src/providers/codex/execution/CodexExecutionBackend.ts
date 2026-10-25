import type {
  ProviderExecutionBackend,
  ProviderExecutionSession,
  ProviderSessionConfig,
} from '../../../core/execution';
import type { ProviderRuntimeHost } from '../../../core/providers/ProviderRuntimeHost';
import type { CodexAppServerRuntime } from '../runtime/CodexAppServerRuntime';
import { CodexExecutionSession } from './CodexExecutionSession';

/**
 * Cheap Codex execution entry point. Sessions own threads on the workspace runtime.
 */
export class CodexExecutionBackend implements ProviderExecutionBackend {
  readonly providerId = 'codex' as const;

  constructor(
    private readonly host: ProviderRuntimeHost,
    /** Resolved per session so the backend stays cheap before workspace services initialize. */
    private readonly resolveRuntime: () => CodexAppServerRuntime,
    /** Saved Codex preferences, else the current selections; wired by Codex integration. */
  ) {}

  createSession(config: ProviderSessionConfig): ProviderExecutionSession {
    return new CodexExecutionSession(this.host, config, this.resolveRuntime());
  }
}
