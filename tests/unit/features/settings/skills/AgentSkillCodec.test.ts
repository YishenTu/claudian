import {
  AgentSkillCodecError,
  parseAgentSkillMarkdown,
  serializeAgentSkillMarkdown,
} from '@/core/skills/AgentSkillCodec';

describe('AgentSkillCodec', () => {
  const valid = [
    '---',
    'name: portable-skill',
    'description: A portable skill',
    'license: MIT',
    'compatibility: "Requires git: 2.x"',
    'metadata: {"owner":"team","nested":{"enabled":true}}',
    '---',
    'Use this skill carefully.',
    '',
  ].join('\n');

  it('parses a valid portable skill document', () => {
    expect(parseAgentSkillMarkdown(valid, 'portable-skill')).toEqual({
      name: 'portable-skill',
      description: 'A portable skill',
      instructions: 'Use this skill carefully.',
      frontmatter: {
        name: 'portable-skill',
        description: 'A portable skill',
        license: 'MIT',
        compatibility: 'Requires git: 2.x',
        metadata: { owner: 'team', nested: { enabled: true } },
      },
    });
  });

  it.each([
    ['missing frontmatter', 'Use this skill.', 'portable-skill'],
    ['missing name', '---\ndescription: Desc\n---\nBody', 'portable-skill'],
    ['missing description', '---\nname: portable-skill\n---\nBody', 'portable-skill'],
    ['mismatched name', '---\nname: another-skill\ndescription: Desc\n---\nBody', 'portable-skill'],
    ['empty body', '---\nname: portable-skill\ndescription: Desc\n---\n   ', 'portable-skill'],
  ])('rejects %s', (_label, content, directoryName) => {
    expect(() => parseAgentSkillMarkdown(content, directoryName)).toThrow(AgentSkillCodecError);
  });

  it('preserves unknown scalar and nested values while updating owned fields', () => {
    const parsed = parseAgentSkillMarkdown(valid, 'portable-skill');
    const serialized = serializeAgentSkillMarkdown(parsed.frontmatter, {
      name: 'renamed-skill',
      description: 'Updated description',
      instructions: 'Updated instructions.',
    });
    const reparsed = parseAgentSkillMarkdown(serialized, 'renamed-skill');

    expect(reparsed.frontmatter).toMatchObject({
      name: 'renamed-skill',
      description: 'Updated description',
      license: 'MIT',
      compatibility: 'Requires git: 2.x',
      metadata: { owner: 'team', nested: { enabled: true } },
    });
    expect(reparsed.instructions).toBe('Updated instructions.');
  });

  it('handles CRLF input, quoted values, and multiline YAML values', () => {
    const source = [
      '---',
      'name: portable-skill',
      'description: "Quoted description"',
      'notes: |',
      '  first line',
      '  second line',
      '---',
      'First instruction.',
      'Second instruction.',
    ].join('\r\n');

    const parsed = parseAgentSkillMarkdown(source, 'portable-skill');
    const serialized = serializeAgentSkillMarkdown(parsed.frontmatter, {
      name: parsed.name,
      description: parsed.description,
      instructions: parsed.instructions,
    });
    const reparsed = parseAgentSkillMarkdown(serialized, 'portable-skill');

    expect(reparsed.frontmatter.notes).toBe('first line\nsecond line');
    expect(reparsed.instructions).toBe('First instruction.\nSecond instruction.');
  });
});
