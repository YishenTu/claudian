import type { AgentDefinition } from '@/core/types';
import { serializeAgent, validateAgentName } from '@/utils/agent';

describe('validateAgentName', () => {
  it('returns null for valid name', () => {
    expect(validateAgentName('code-reviewer')).toBeNull();
  });

  it('returns null for single character', () => {
    expect(validateAgentName('a')).toBeNull();
  });

  it('returns null for numbers and hyphens', () => {
    expect(validateAgentName('agent-v2')).toBeNull();
  });

  it('returns error for empty name', () => {
    expect(validateAgentName('')).toBe('Agent name is required');
  });

  it('returns error for name exceeding max length', () => {
    const longName = 'a'.repeat(65);
    expect(validateAgentName(longName)).toBe('Agent name must be 64 characters or fewer');
  });

  it('returns null for exactly max length', () => {
    const maxName = 'a'.repeat(64);
    expect(validateAgentName(maxName)).toBeNull();
  });

  it('returns error for uppercase letters', () => {
    expect(validateAgentName('CodeReviewer')).toBe(
      'Agent name can only contain lowercase letters, numbers, and hyphens'
    );
  });

  it('returns error for spaces', () => {
    expect(validateAgentName('code reviewer')).toBe(
      'Agent name can only contain lowercase letters, numbers, and hyphens'
    );
  });

  it('returns error for underscores', () => {
    expect(validateAgentName('code_reviewer')).toBe(
      'Agent name can only contain lowercase letters, numbers, and hyphens'
    );
  });

  it('returns error for special characters', () => {
    expect(validateAgentName('code@reviewer')).toBe(
      'Agent name can only contain lowercase letters, numbers, and hyphens'
    );
  });

  it.each(['true', 'false', 'null', 'yes', 'no', 'on', 'off'])(
    'returns error for YAML reserved word "%s"',
    (word) => {
      expect(validateAgentName(word)).toBe(
        'Agent name cannot be a YAML reserved word (true, false, null, yes, no, on, off)'
      );
    }
  );
});

describe('serializeAgent', () => {
  const baseAgent: AgentDefinition = {
    id: 'test-agent',
    name: 'test-agent',
    description: 'A test agent',
    prompt: 'You are a test agent.',
    source: 'vault',
  };

  it('serializes minimal agent', () => {
    const result = serializeAgent(baseAgent);
    expect(result).toBe(
      '---\nname: test-agent\ndescription: A test agent\n---\nYou are a test agent.'
    );
  });

  it('serializes agent with tools', () => {
    const agent: AgentDefinition = {
      ...baseAgent,
      tools: ['Read', 'Grep'],
    };
    const result = serializeAgent(agent);
    expect(result).toContain('tools:\n  - Read\n  - Grep');
  });

  it('serializes agent with disallowedTools', () => {
    const agent: AgentDefinition = {
      ...baseAgent,
      disallowedTools: ['Write', 'Bash'],
    };
    const result = serializeAgent(agent);
    expect(result).toContain('disallowedTools:\n  - Write\n  - Bash');
  });

  it('serializes agent with model (non-inherit)', () => {
    const agent: AgentDefinition = {
      ...baseAgent,
      model: 'sonnet',
    };
    const result = serializeAgent(agent);
    expect(result).toContain('model: sonnet');
  });

  it('omits model when inherit', () => {
    const agent: AgentDefinition = {
      ...baseAgent,
      model: 'inherit',
    };
    const result = serializeAgent(agent);
    expect(result).not.toContain('model:');
  });

  it('serializes agent with permissionMode', () => {
    const agent: AgentDefinition = {
      ...baseAgent,
      permissionMode: 'dontAsk',
    };
    const result = serializeAgent(agent);
    expect(result).toContain('permissionMode: dontAsk');
  });

  it('omits permissionMode when undefined', () => {
    const result = serializeAgent(baseAgent);
    expect(result).not.toContain('permissionMode');
  });

  it('serializes agent with skills', () => {
    const agent: AgentDefinition = {
      ...baseAgent,
      skills: ['my-skill', 'another'],
    };
    const result = serializeAgent(agent);
    expect(result).toContain('skills:\n  - my-skill\n  - another');
  });

  it('quotes description with special YAML characters', () => {
    const agent: AgentDefinition = {
      ...baseAgent,
      description: 'Test: agent with #special chars',
    };
    const result = serializeAgent(agent);
    expect(result).toContain('description: "Test: agent with #special chars"');
  });

  it('includes prompt as body after frontmatter', () => {
    const agent: AgentDefinition = {
      ...baseAgent,
      prompt: 'Multi\nline\nprompt',
    };
    const result = serializeAgent(agent);
    expect(result).toMatch(/---\nMulti\nline\nprompt$/);
  });

  it('serializes hooks as JSON', () => {
    const agent: AgentDefinition = {
      ...baseAgent,
      hooks: { preToolUse: { command: 'echo test' } },
    };
    const result = serializeAgent(agent);
    expect(result).toContain('hooks: {"preToolUse":{"command":"echo test"}}');
  });

  it('omits hooks when undefined', () => {
    const result = serializeAgent(baseAgent);
    expect(result).not.toContain('hooks');
  });

  it('serializes all fields together', () => {
    const agent: AgentDefinition = {
      ...baseAgent,
      tools: ['Read'],
      disallowedTools: ['Bash'],
      model: 'opus',
      permissionMode: 'acceptEdits',
      skills: ['review'],
    };
    const result = serializeAgent(agent);
    expect(result).toContain('name: test-agent');
    expect(result).toContain('description: A test agent');
    expect(result).toContain('tools:\n  - Read');
    expect(result).toContain('disallowedTools:\n  - Bash');
    expect(result).toContain('model: opus');
    expect(result).toContain('permissionMode: acceptEdits');
    expect(result).toContain('skills:\n  - review');
  });
});
