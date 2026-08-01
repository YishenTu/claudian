import type {
  ProviderExecutionBackend,
  ProviderSessionConfig,
} from '../../../core/execution';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { ClaudeWorkspaceServices } from '../app/ClaudeWorkspaceServices';
import { ClaudeExecutionSession } from './ClaudeExecutionSession';

type ClaudeExecutionBackendServices = Pick<
  ClaudeWorkspaceServices,
  'agentManager' | 'commandCatalog' | 'mcpManager' | 'pluginManager'
>;

export class ClaudeExecutionBackend implements ProviderExecutionBackend {
  readonly providerId = 'claude' as const;

  constructor(
    private readonly host: ProviderHost,
    private readonly services: ClaudeExecutionBackendServices,
  ) {}

  createSession(config: ProviderSessionConfig): ClaudeExecutionSession {
    return new ClaudeExecutionSession(
      this.host,
      this.services,
      config,
    );
  }
}
