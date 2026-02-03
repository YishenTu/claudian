import { AgentManager } from '@/core/agents';
import { buildAgentFromFrontmatter, parseAgentFile } from '@/core/agents';

describe('core/agents index', () => {
  it('re-exports runtime symbols', () => {
    expect(AgentManager).toBeDefined();
    expect(buildAgentFromFrontmatter).toBeDefined();
    expect(parseAgentFile).toBeDefined();
  });
});

