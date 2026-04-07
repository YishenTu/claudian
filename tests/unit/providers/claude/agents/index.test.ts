import { AgentManager } from '@/providers/claude/agents/AgentManager';
import { buildAgentFromFrontmatter, parseAgentFile } from '@/providers/claude/agents/AgentStorage';

describe('providers/claude/agents index', () => {
  it('re-exports runtime symbols', () => {
    expect(AgentManager).toBeDefined();
    expect(buildAgentFromFrontmatter).toBeDefined();
    expect(parseAgentFile).toBeDefined();
  });
});
