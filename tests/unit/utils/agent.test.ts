import { buildAgentFromFrontmatter, parseAgentFile } from '@/core/agents/AgentStorage';
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

  it('quotes list items containing colons', () => {
    const agent: AgentDefinition = {
      ...baseAgent,
      tools: ['mcp__server:tool', 'Read'],
    };
    const result = serializeAgent(agent);
    expect(result).toContain('  - "mcp__server:tool"');
    expect(result).toContain('  - Read');
  });

  it('quotes list items containing hash', () => {
    const agent: AgentDefinition = {
      ...baseAgent,
      skills: ['skill#1'],
    };
    const result = serializeAgent(agent);
    expect(result).toContain('  - "skill#1"');
  });

  it('quotes list items with leading spaces', () => {
    const agent: AgentDefinition = {
      ...baseAgent,
      tools: [' leading-space'],
    };
    const result = serializeAgent(agent);
    expect(result).toContain('  - " leading-space"');
  });

  it('serializes extraFrontmatter keys', () => {
    const agent: AgentDefinition = {
      ...baseAgent,
      extraFrontmatter: { maxTurns: 5, customFlag: true },
    };
    const result = serializeAgent(agent);
    expect(result).toContain('maxTurns: 5');
    expect(result).toContain('customFlag: true');
  });

  it('omits extraFrontmatter when undefined', () => {
    const result = serializeAgent(baseAgent);
    expect(result).not.toContain('extraFrontmatter');
  });
});

describe('serializeAgent / parseAgentFile round-trip', () => {
  it('round-trips a minimal agent', () => {
    const agent: AgentDefinition = {
      id: 'my-agent',
      name: 'my-agent',
      description: 'A test agent',
      prompt: 'You are a test agent.',
      source: 'vault',
    };

    const serialized = serializeAgent(agent);
    const parsed = parseAgentFile(serialized);
    expect(parsed).not.toBeNull();

    const rebuilt = buildAgentFromFrontmatter(parsed!.frontmatter, parsed!.body, {
      id: parsed!.frontmatter.name,
      source: 'vault',
    });

    expect(rebuilt.name).toBe(agent.name);
    expect(rebuilt.description).toBe(agent.description);
    expect(rebuilt.prompt).toBe(agent.prompt);
  });

  it('round-trips a fully populated agent', () => {
    const agent: AgentDefinition = {
      id: 'full-agent',
      name: 'full-agent',
      description: 'Full agent',
      prompt: 'Do everything.',
      tools: ['Read', 'Grep'],
      disallowedTools: ['Bash'],
      model: 'opus',
      permissionMode: 'acceptEdits',
      skills: ['review', 'deploy'],
      hooks: { preToolUse: { command: 'echo test' } },
      source: 'vault',
    };

    const serialized = serializeAgent(agent);
    const parsed = parseAgentFile(serialized);
    expect(parsed).not.toBeNull();

    const rebuilt = buildAgentFromFrontmatter(parsed!.frontmatter, parsed!.body, {
      id: parsed!.frontmatter.name,
      source: 'vault',
    });

    expect(rebuilt.name).toBe(agent.name);
    expect(rebuilt.description).toBe(agent.description);
    expect(rebuilt.prompt).toBe(agent.prompt);
    expect(rebuilt.tools).toEqual(agent.tools);
    expect(rebuilt.disallowedTools).toEqual(agent.disallowedTools);
    expect(rebuilt.model).toBe(agent.model);
    expect(rebuilt.permissionMode).toBe(agent.permissionMode);
    expect(rebuilt.skills).toEqual(agent.skills);
    expect(rebuilt.hooks).toEqual(agent.hooks);
  });

  it('round-trips tools with special YAML characters', () => {
    const agent: AgentDefinition = {
      id: 'special-tools',
      name: 'special-tools',
      description: 'Agent with special tool names',
      prompt: 'Use special tools.',
      tools: ['mcp__server:tool', 'Read'],
      source: 'vault',
    };

    const serialized = serializeAgent(agent);
    const parsed = parseAgentFile(serialized);
    expect(parsed).not.toBeNull();

    const rebuilt = buildAgentFromFrontmatter(parsed!.frontmatter, parsed!.body, {
      id: parsed!.frontmatter.name,
      source: 'vault',
    });

    expect(rebuilt.tools).toEqual(['mcp__server:tool', 'Read']);
  });

  it('round-trips unknown frontmatter keys', () => {
    const content = `---
name: custom-agent
description: An agent with extra keys
maxTurns: 5
mcpServers: ["server1"]
---
Do stuff.`;

    const parsed = parseAgentFile(content);
    expect(parsed).not.toBeNull();

    const rebuilt = buildAgentFromFrontmatter(parsed!.frontmatter, parsed!.body, {
      id: parsed!.frontmatter.name,
      source: 'vault',
    });

    expect(rebuilt.extraFrontmatter).toEqual({
      maxTurns: 5,
      mcpServers: ['server1'],
    });

    const reserialized = serializeAgent(rebuilt);
    expect(reserialized).toContain('maxTurns: 5');
    expect(reserialized).toContain('mcpServers:');

    const reparsed = parseAgentFile(reserialized);
    expect(reparsed).not.toBeNull();

    const rebuilt2 = buildAgentFromFrontmatter(reparsed!.frontmatter, reparsed!.body, {
      id: reparsed!.frontmatter.name,
      source: 'vault',
    });

    expect(rebuilt2.extraFrontmatter?.maxTurns).toBe(5);
  });

  it('does not set extraFrontmatter when no unknown keys exist', () => {
    const agent: AgentDefinition = {
      id: 'no-extra',
      name: 'no-extra',
      description: 'Standard agent',
      prompt: 'Do stuff.',
      source: 'vault',
    };

    const serialized = serializeAgent(agent);
    const parsed = parseAgentFile(serialized);
    expect(parsed).not.toBeNull();

    const rebuilt = buildAgentFromFrontmatter(parsed!.frontmatter, parsed!.body, {
      id: parsed!.frontmatter.name,
      source: 'vault',
    });

    expect(rebuilt.extraFrontmatter).toBeUndefined();
  });

  it('round-trips description with special YAML characters', () => {
    const agent: AgentDefinition = {
      id: 'special-desc',
      name: 'special-desc',
      description: 'Test: agent with #special chars',
      prompt: 'Handle edge cases.',
      source: 'vault',
    };

    const serialized = serializeAgent(agent);
    const parsed = parseAgentFile(serialized);
    expect(parsed).not.toBeNull();

    const rebuilt = buildAgentFromFrontmatter(parsed!.frontmatter, parsed!.body, {
      id: parsed!.frontmatter.name,
      source: 'vault',
    });

    expect(rebuilt.description).toBe(agent.description);
  });
});
