import { getFrontMatterInfo, parseYaml } from 'obsidian';

// Obsidian 1.13.7 app.js yL calls YAML.parse(source, null, {}): ordinary strict
// single-document parsing, including YAML's leading-BOM handling.
it('parses nested YAML and rejects malformed mappings with or without a leading BOM', () => {
  for (const prefix of ['', '\uFEFF']) {
    expect(parseYaml(`${prefix}name: Example\noptions:\n  enabled: true\n  names: [One, Two]\n`))
      .toEqual({ name: 'Example', options: { enabled: true, names: ['One', 'Two'] } });
    expect(() => parseYaml(`${prefix}description: Use when: x\n`)).toThrow();
  }
  expect(() => parseYaml('name: one\nname: two\n')).toThrow();
  expect(() => parseYaml('name: one\n---\nname: two\n')).toThrow();
});

// app.js _T uses /^---(\r?\n)/ and /---(\r?\n|$)/, requiring the closing
// delimiter to start after a newline. It deliberately does not trim BOM/space.
it.each([
  { source: '---\na: one\n---\nBody', from: 4, to: 11, contentStart: 15, frontmatter: 'a: one\n' },
  { source: '---\r\na: one\r\n---\r\nBody', from: 5, to: 13, contentStart: 18, frontmatter: 'a: one\r\n' },
  { source: '---\nkey: a---\n---', from: 4, to: 14, contentStart: 17, frontmatter: 'key: a---\n' },
])('reports host frontmatter boundaries in $source', ({ source, ...expected }) => {
  expect(getFrontMatterInfo(source)).toEqual({ exists: true, ...expected });
});

it.each(['Body', '\uFEFF---\na: one\n---\nBody', ' ---\na: one\n---\nBody', '---\na: one', '---'])(
  'leaves unrecognized or unterminated frontmatter in the content: %j', source => {
  expect(getFrontMatterInfo(source)).toEqual({ exists: false, from: 0, to: 0, contentStart: 0, frontmatter: '' });
  });
