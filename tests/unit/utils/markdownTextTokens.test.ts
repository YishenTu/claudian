import { filterMarkdownTextTokens } from '@/utils/markdownTextTokens';

function tokens(text: string) {
  return [...text.matchAll(/@token/g)].map(match => ({ index: match.index, fullMatch: match[0] }));
}

it.each([
  '`example @token here`',
  '```md\n@token\n```',
  '    @token',
  '\\@token',
])('excludes literal tokens while preserving prose offsets: %s', example => {
  const text = `${example}\n\nUse @token here`;
  expect(filterMarkdownTextTokens(text, tokens(text))).toEqual([
    { index: text.lastIndexOf('@token'), fullMatch: '@token' },
  ]);
});

it('recognizes a token following an escaped backslash', () => {
  const text = '\\\\@token';
  expect(filterMarkdownTextTokens(text, tokens(text))).toEqual([{ index: 2, fullMatch: '@token' }]);
});

it('can allow code within a token without allowing tokens that start inside code', () => {
  const text = '@[Fix `bug`](session)';
  const token = { index: 0, fullMatch: text };
  expect(filterMarkdownTextTokens(text, [token])).toEqual([]);
  expect(filterMarkdownTextTokens(text, [token], true)).toEqual([token]);
  expect(filterMarkdownTextTokens('```\n' + text + '\n```', [{ ...token, index: 4 }], true)).toEqual([]);
});
