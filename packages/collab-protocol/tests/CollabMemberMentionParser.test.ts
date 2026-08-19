import { parseCollabMemberMentions } from '../src/index';

describe('parseCollabMemberMentions', () => {
  it('resolves visible Member names to stable IDs in first-seen order', () => {
    expect(parseCollabMemberMentions(
      'Ask @Alice Chen, then @山田 太郎 and @Alice Chen again.',
      [
        { displayName: 'Alice Chen', memberId: 'member-a' },
        { displayName: '山田 太郎', memberId: 'member-b' },
      ],
    )).toEqual(['member-a', 'member-b']);
  });

  it('prefers the longest exact active name and skips ambiguous names', () => {
    expect(parseCollabMemberMentions(
      'Ask @Alice Chen, @Alice, @Alex Kim, and @Bob.',
      [
        { displayName: 'Alice', memberId: 'member-alice' },
        { displayName: 'Alice Chen', memberId: 'member-alice-chen' },
        { displayName: 'Alex Kim', memberId: 'member-alex-a' },
        { displayName: 'Alex Kim', memberId: 'member-alex-b' },
        { displayName: 'Bob', memberId: 'member-bob' },
      ],
    )).toEqual(['member-alice-chen', 'member-alice', 'member-bob']);
  });

  it('ignores escaped mentions, code, email addresses, and unknown names', () => {
    expect(mentions([
      String.raw`Ignore \@Escaped and user@Example.com.`,
      '`@Inline Code`',
      '```text',
      '@Fenced Code',
      '```',
      'Keep @Valid Member and ignore @Unknown Member.',
    ].join('\n'), 'Escaped', 'Example.com', 'Inline Code', 'Fenced Code', 'Valid Member'))
      .toEqual(['Valid Member']);
  });

  it('ignores mentions inside blockquoted and list-nested fenced code', () => {
    expect(mentions([
      '> ~~~text',
      '> @Blockquote Member',
      '> ~~~',
      '- ```text',
      '  @List Member',
      '  ```',
      'Keep @Valid Member.',
    ].join('\n'), 'Blockquote Member', 'List Member', 'Valid Member'))
      .toEqual(['Valid Member']);
  });

  it('does not let a literal container prefix close a top-level fence', () => {
    expect(mentions([
      '```text',
      '> ```',
      '@Code Member',
      '```',
      'Keep @Valid Member.',
    ].join('\n'), 'Code Member', 'Valid Member')).toEqual(['Valid Member']);
  });

  it('resumes parsing prose after leaving a list-nested fence container', () => {
    expect(mentions([
      '- ```text',
      '  @Code Member',
      'Keep @Valid Member.',
    ].join('\n'), 'Code Member', 'Valid Member')).toEqual(['Valid Member']);
  });

  it('keeps mentions after unmatched backticks in prose', () => {
    expect(mentions(
      'Unclosed ` marker @Alice Chen.',
      'Alice Chen',
    )).toEqual(['Alice Chen']);
  });

  it('preserves rendered punctuation boundaries for Markdown escapes', () => {
    expect(mentions(
      String.raw`Ignore word\_@False Name and word\@@Also False; keep @Valid Member.`,
      'False Name',
      'Also False',
      'Valid Member',
    )).toEqual(['Valid Member']);
  });

  it('excludes Markdown destinations, autolinks, and adjacent at-sign runs', () => {
    expect(mentions([
      'See [@Visible Member](https://host/u/@Destination).',
      'See [@Reference Visible][hidden-@ReferenceDestination].',
      '![@Image Member](https://host/image.png)',
      '[Docs](https://host/ "Ask @Title Member")',
      'Before <!-- Ask @Comment Member --> after.',
      'Before <?member Ask @Processing Member?> after.',
      '<https://host/u/@Autolink>',
      '@Adjacent Member@outside',
      '',
      '[hidden-@ReferenceDestination]: https://host/profile',
    ].join('\n'),
    'Visible Member',
    'Destination',
    'Reference Visible',
    'ReferenceDestination',
    'Image Member',
    'Title Member',
    'Comment Member',
    'Processing Member',
    'Autolink',
    'Adjacent Member',
    )).toEqual(['Visible Member', 'Reference Visible']);
  });

  it('does not manufacture mention boundaries when masking Markdown entities', () => {
    expect(mentions(
      'Ignore word&#95;@False Name and &#64;Entity Member. Keep @Valid Member.',
      'False Name',
      'Entity Member',
      'Valid Member',
    )).toEqual(['Valid Member']);
  });
});

function mentions(markdown: string, ...displayNames: readonly string[]): readonly string[] {
  return parseCollabMemberMentions(
    markdown,
    displayNames.map(displayName => ({ displayName, memberId: displayName })),
  );
}
