import { parseAgentFile } from '@/core/agents/AgentStorage';

describe('parseAgentFile', () => {
  it('parses valid frontmatter and body', () => {
    const content = `---
name: TestAgent
description: Handles tests
tools: [Read, Grep]
disallowedTools: [Write]
model: sonnet
---
You are helpful.`;

    const parsed = parseAgentFile(content);
    expect(parsed).not.toBeNull();
    expect(parsed?.frontmatter.name).toBe('TestAgent');
    expect(parsed?.frontmatter.description).toBe('Handles tests');
    expect(parsed?.frontmatter.tools).toEqual(['Read', 'Grep']);
    expect(parsed?.frontmatter.disallowedTools).toEqual(['Write']);
    expect(parsed?.frontmatter.model).toBe('sonnet');
    expect(parsed?.body).toBe('You are helpful.');
  });

  it('rejects non-string name', () => {
    const content = `---
name: [NotAString]
description: Valid description
---
Body.`;

    expect(parseAgentFile(content)).toBeNull();
  });

  it('rejects non-string description', () => {
    const content = `---
name: ValidName
description: [NotAString]
---
Body.`;

    expect(parseAgentFile(content)).toBeNull();
  });

  it('rejects invalid tools type', () => {
    const content = `---
name: ValidName
description: Valid description
tools: true
---
Body.`;

    expect(parseAgentFile(content)).toBeNull();
  });

  it('rejects invalid disallowedTools type', () => {
    const content = `---
name: ValidName
description: Valid description
disallowedTools: 123
---
Body.`;

    expect(parseAgentFile(content)).toBeNull();
  });
});
