import { parse } from 'yaml';

import { buildDeepSeekPresetPlugins, parseDeepSeekPresetPlugins, renderDeepSeekPresetPreview } from '@/providers/deepseek/runtime/DeepSeekPresetPlugins';

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
    ['Claudian sessions bridge', '- { id: claudian-sessions, name: x }\n', /"claudian-sessions".*Claudian/],
    ['a built-in tool row', '- { id: tool-bash, name: "@deepseek-ai/dsh-tool-bash" }\n', /"tool-bash".*Claudian/],
    ['a row nested in Claudian\'s compaction group', '- { id: compaction, name: "cordis:group" }\n', /"compaction".*Claudian/],
  ])('rejects %s with an actionable message', (_case, text, message) => {
    expect(() => parseDeepSeekPresetPlugins(text)).toThrow(message);
  });

  // Native mounts only the platform's shell executor (dsh-base: PowerShell on Windows), so the tool must match it.
  it.each<[NodeJS.Platform, string, string]>([['win32', 'tool-pwsh', 'tool-bash'], ['darwin', 'tool-bash', 'tool-pwsh']])(
    'gives chat presets the shell tool native executes on %s', (platform, shell, other) => {
      const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: platform });
      try {
        const paths = { sessions: '/s.mjs', sessionToolsFile: '/endpoint', compatibility: '/c.mjs', codeModeFile: '/code-mode', promptFile: () => '/prompt.txt' };
        const ids = buildDeepSeekPresetPlugins('claudian', paths).map(row => row.id);
        expect(ids).toContain(shell);
        expect(ids).not.toContain(other);
        expect(() => parseDeepSeekPresetPlugins(`- { id: ${shell}, name: x }\n`)).toThrow(new RegExp(`"${shell}".*Claudian`));
      } finally { Object.defineProperty(process, 'platform', original); }
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

it.each(['claudian', 'claudian-code'] as const)('places the sessions bridge in %s before user plugins', preset => {
  const paths = { compatibility: '/c.mjs', codeModeFile: '/mode', promptFile: () => '/prompt', sessions: '/sessions.mjs', sessionToolsFile: '/endpoint.json' };
  const rows = buildDeepSeekPresetPlugins(preset, paths, [{ id: 'custom', name: 'custom' }]);
  const sessions = rows.find(row => row.id === 'claudian-sessions');
  expect(sessions).toEqual({ id: 'claudian-sessions', name: '/sessions.mjs', config: expect.objectContaining({ endpointFile: '/endpoint.json' }) });
  expect(rows.indexOf(sessions!)).toBeLessThan(rows.findIndex(row => row.id === 'custom'));
});

it.each(['claudian-passive', 'claudian-read-only'] as const)('keeps session tools out of %s', preset => {
  const paths = { compatibility: '/c.mjs', codeModeFile: '/mode', promptFile: () => '/prompt', sessions: '/sessions.mjs', sessionToolsFile: '/endpoint.json' };
  expect(buildDeepSeekPresetPlugins(preset, paths).map(row => row.id)).not.toContain('claudian-sessions');
});

// Native tool-skill injects a user's `/name` gesture in its pre-step; Inline Edit (read-only) offers skills like chat.
it.each([['claudian', true], ['claudian-read-only', true], ['claudian-passive', false]] as const)('mounts user-invocable skills in %s: %s', (preset, mounted) => {
  const paths = { compatibility: '/c.mjs', codeModeFile: '/mode', promptFile: () => '/prompt', sessions: '/sessions.mjs', sessionToolsFile: '/endpoint.json' };
  const ids = buildDeepSeekPresetPlugins(preset, paths).map(row => row.id);
  expect(ids.includes('skill-filesystem') && ids.includes('tool-skill')).toBe(mounted);
});
