import type { query as claudeAgentQuery } from '@anthropic-ai/claude-agent-sdk';

import type * as ClaudeAgentQueryModule from './claudeAgentQueryModule';

let modulePromise: Promise<typeof ClaudeAgentQueryModule> | undefined;

export function loadClaudeAgentQuery(): Promise<typeof claudeAgentQuery> {
  modulePromise ??= import('./claudeAgentQueryModule');
  return modulePromise.then(({ query }) => query);
}
