import { StoredAgentMentionProvider } from '../../../core/providers/agents/StoredAgentMentionProvider';
import type { CodexSubagentStorage } from '../storage/CodexSubagentStorage';
import type { CodexSubagentDefinition } from '../types/subagent';

export class CodexAgentMentionProvider
  extends StoredAgentMentionProvider<CodexSubagentDefinition> {
  constructor(storage: CodexSubagentStorage) {
    super(storage, { source: 'vault' });
  }
}
