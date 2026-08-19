import {
  parseCollabTicketReferences,
  scanCollabTicketReferences,
} from '../src/CollabTicketReferenceParser';

describe('CollabTicketReferenceParser', () => {
  it('parses bare Ticket numbers as references', () => {
    expect(parseCollabTicketReferences('Related to #171 and #4.')).toEqual({
      status: 'ok',
      references: [
        { ticketNumber: 4, kind: 'references' },
        { ticketNumber: 171, kind: 'references' },
      ],
    });
  });

  it.each([
    'close',
    'closes',
    'closed',
    'fix',
    'fixes',
    'fixed',
    'resolve',
    'resolves',
    'resolved',
  ])('parses %s as a closing keyword', keyword => {
    expect(parseCollabTicketReferences(`${keyword.toUpperCase()}: #17`)).toEqual({
      status: 'ok',
      references: [{ ticketNumber: 17, kind: 'resolves' }],
    });
  });

  it('scopes a closing keyword to one reference and lets resolves win duplicates', () => {
    expect(parseCollabTicketReferences(
      'Fixes #2, #3. Earlier context: #2. Resolves #4, resolves #5.',
    )).toEqual({
      status: 'ok',
      references: [
        { ticketNumber: 2, kind: 'resolves' },
        { ticketNumber: 3, kind: 'references' },
        { ticketNumber: 4, kind: 'resolves' },
        { ticketNumber: 5, kind: 'resolves' },
      ],
    });
  });

  it('ignores fenced code, inline code, escaped hashes, and non-canonical numbers', () => {
    const description = [
      'Keep #1.',
      '`Fixes #2`',
      '\\#3',
      '```md',
      'Resolves #4',
      '```',
      '~~~',
      '#5',
      '~~~',
      'Ignore #0, #01, and #7suffix.',
    ].join('\n');

    expect(parseCollabTicketReferences(description)).toEqual({
      status: 'ok',
      references: [{ ticketNumber: 1, kind: 'references' }],
    });
    expect(scanCollabTicketReferences(description)).toEqual({
      status: 'ok',
      tokens: [{
        from: description.indexOf('#1'),
        kind: 'references',
        ticketNumber: 1,
        to: description.indexOf('#1') + 2,
      }],
    });
  });

  it('ignores Ticket syntax inside blockquoted and list-nested fenced code', () => {
    const description = [
      '> ~~~text',
      '> Resolves #12',
      '> ~~~',
      '- ```text',
      '  Fixes #13',
      '  ```',
      'Keep #14.',
    ].join('\n');

    expect(parseCollabTicketReferences(description)).toEqual({
      status: 'ok',
      references: [{ ticketNumber: 14, kind: 'references' }],
    });
  });

  it('does not let a literal container prefix close a top-level fence', () => {
    expect(parseCollabTicketReferences([
      '~~~text',
      '> ~~~',
      'Resolves #15',
      '~~~',
      'Keep #16.',
    ].join('\n'))).toEqual({
      status: 'ok',
      references: [{ ticketNumber: 16, kind: 'references' }],
    });
  });

  it('resumes parsing prose after leaving a blockquoted fence container', () => {
    expect(parseCollabTicketReferences([
      '> ```text',
      '> Resolves #17',
      'Keep #18.',
    ].join('\n'))).toEqual({
      status: 'ok',
      references: [{ ticketNumber: 18, kind: 'references' }],
    });
  });

  it('keeps Ticket syntax after unmatched backticks in prose', () => {
    expect(parseCollabTicketReferences(
      'Unclosed ` marker. Resolves #17.',
    )).toEqual({
      status: 'ok',
      references: [{ ticketNumber: 17, kind: 'resolves' }],
    });
    expect(parseCollabTicketReferences([
      '```invalid`',
      'Keep #18.',
    ].join('\n'))).toEqual({
      status: 'ok',
      references: [{ ticketNumber: 18, kind: 'references' }],
    });
  });

  it('requires canonical Ticket token and same-line closing-keyword boundaries', () => {
    const description = String.raw`Resolves \##7. Ignore ##9.
Resolves

#8. Valid Resolves #10.`;

    expect(parseCollabTicketReferences(description)).toEqual({
      status: 'ok',
      references: [
        { ticketNumber: 8, kind: 'references' },
        { ticketNumber: 10, kind: 'resolves' },
      ],
    });
    expect(scanCollabTicketReferences('Keep #8 and #10.')).toEqual({
      status: 'ok',
      tokens: [{
        from: 5,
        kind: 'references',
        ticketNumber: 8,
        to: 7,
      }, {
        from: 12,
        kind: 'references',
        ticketNumber: 10,
        to: 15,
      }],
    });
  });

  it('scans visible link labels but excludes Markdown destinations and definitions', () => {
    expect(parseCollabTicketReferences([
      'See [Ticket #12](https://host/#13).',
      'See [Ticket #21][hidden-#22].',
      '![Resolves #23](https://host/image.png)',
      '[Docs](https://host/ "Resolves #15")',
      'Before <!-- Resolves #16 --> after.',
      'Before <?ticket Resolves #17?> after.',
      '',
      '[ticket-docs]: https://host/#14',
      '[hidden-#22]: https://host/ticket',
    ].join('\n'))).toEqual({
      status: 'ok',
      references: [
        { ticketNumber: 12, kind: 'references' },
        { ticketNumber: 21, kind: 'references' },
      ],
    });
  });

  it('does not manufacture Ticket boundaries when masking Markdown entities', () => {
    expect(parseCollabTicketReferences(
      'Ignore word&#95;#18 and &#35;19. Keep #20.',
    )).toEqual({
      status: 'ok',
      references: [{ ticketNumber: 20, kind: 'references' }],
    });
  });

  it('rejects an out-of-range Ticket number without echoing input', () => {
    expect(parseCollabTicketReferences(`Resolves #${Number.MAX_SAFE_INTEGER}0`))
      .toEqual({
        status: 'invalid',
        reason: 'ticket-number-out-of-range',
      });
  });
});
