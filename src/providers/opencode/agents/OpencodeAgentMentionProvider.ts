import { StoredAgentMentionProvider } from '../../../core/providers/agents/StoredAgentMentionProvider';
import type { OpencodeAgentStorage } from '../storage/OpencodeAgentStorage';
import type { OpencodeAgentDefinition } from '../types/agent';

export class OpencodeAgentMentionProvider
  extends StoredAgentMentionProvider<OpencodeAgentDefinition> {
  constructor(storage: OpencodeAgentStorage) {
    super(storage, {
      isMentionable: isMentionableSubagent,
      source: 'vault',
    });
  }
}

function isMentionableSubagent(agent: OpencodeAgentDefinition): boolean {
  if (agent.hidden || agent.disable) {
    return false;
  }

  return agent.mode === 'subagent';
}
