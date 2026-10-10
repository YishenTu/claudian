import { parse } from 'yaml';

import { parseDeepSeekPresetPlugins, renderDeepSeekPresetPreview } from '@/providers/deepseek/runtime/DeepSeekPresetPlugins';

describe('DeepSeek additional preset plugins', () => {
  it('reads native plugin rows in dsh\'s YAML dialect and treats blank input as none', () => {
    expect(parseDeepSeekPresetPlugins('')).toEqual([]);
    expect(parseDeepSeekPresetPlugins('  \n # nothing yet\n')).toEqual([]);
    expect(parseDeepSeekPresetPlugins(`
# The todo tool, which the dsh base composes on the host plane
- id: tool-todo
  name: '@deepseek-ai/dsh-tool-todo'
  config:
    allowParallelInProgress: true
- id: planning
  name: cordis:group
  group: true
  disabled: !!js "process.platform === 'win32'"
  config:
    - id: plan-mode
      name: '@deepseek-ai/dsh-plan-mode'
`)).toEqual([
      { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
      // dsh's loader evaluates this expression form, exactly as its own YAML include produces it.
      { id: 'planning', name: 'cordis:group', group: true, disabled: { __jsExpr: "process.platform === 'win32'" },
        config: [{ id: 'plan-mode', name: '@deepseek-ai/dsh-plan-mode' }] },
    ]);
  });

  it('still reads rows saved as JSON', () => {
    expect(parseDeepSeekPresetPlugins('[{ "id": "tool-todo", "name": "@deepseek-ai/dsh-tool-todo", "config": { "allowParallelInProgress": true } }]'))
      .toEqual([{ id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } }]);
  });

  it.each([
    ['malformed YAML', '- id: a\n  name: [b\n', /YAML.*line \d+/],
    // dsh's dialect is JSON-typed YAML: other YAML tags are not rows dsh could load.
    ['a tag outside dsh\'s dialect', '- id: a\n  name: b\n  config: !!binary aGVsbG8=\n', /rows\[0\]\.config/],
    ['a non-list', 'id: a\nname: b\n', /list/],
    ['a non-object row', '- tool-todo\n', /row 1/],
    ['a row without an id', '- name: b\n', /row 1.*id/],
    ['a row without a module name', '- id: a\n', /"a".*name/],
    ['duplicate ids', '- { id: a, name: b }\n- { id: a, name: c }\n', /"a".*more than once/],
    // Claudian's own rows (bridge, tool policy and interactive tools Claudian renders) cannot be replaced or shadowed.
    ['Claudian\'s compatibility bridge', '- { id: claudian-compatibility, name: x }\n', /"claudian-compatibility".*Claudian/],
    ['a built-in tool row', '- { id: tool-bash, name: "@deepseek-ai/dsh-tool-bash" }\n', /"tool-bash".*Claudian/],
    ['a row nested in Claudian\'s compaction group', '- { id: compaction, name: "cordis:group" }\n', /"compaction".*Claudian/],
  ])('rejects %s with an actionable message', (_case, text, message) => {
    expect(() => parseDeepSeekPresetPlugins(text)).toThrow(message);
  });

  it('previews the effective chat preset as YAML without machine-specific launch paths', () => {
    const additional = parseDeepSeekPresetPlugins('- id: tool-todo\n  name: "@deepseek-ai/dsh-tool-todo"\n  disabled: !!js "1 > 2"\n');
    const text = renderDeepSeekPresetPreview(additional);
    // Expressions read back in dsh's own notation.
    expect(text).toContain('disabled: !!js 1 > 2');
    const preview = parse(text.replace('!!js 1 > 2', 'false')) as Array<Record<string, unknown>>;
    expect(preview[0]).toEqual({ id: 'claudian-compatibility', name: '<claudian-compatibility.mjs>', config: { promptFile: '<system prompt>', codeModeFile: '<code mode>' } });
    expect(preview.at(-1)).toEqual({ id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', disabled: false });
    expect(preview.map(row => row.id)).toEqual(expect.arrayContaining(['tool-bash', 'tool-ask-user', 'compaction']));
    expect(text).not.toMatch(/claudian-deepseek-|\/tmp\/|\\\\/);
    expect((parse(renderDeepSeekPresetPreview([])) as Array<{ id: string }>).at(-1)!.id).toBe('compaction');
  });
});
