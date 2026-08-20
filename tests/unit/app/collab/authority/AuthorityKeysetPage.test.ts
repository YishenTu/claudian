import { COLLAB_LIMITS } from '@claudian/collab-protocol';

import {
  authorityDetailPageBudgets,
  decodeAuthorityKeysetCursor,
  encodeAuthorityKeysetCursor,
  trimAuthorityKeysetPage,
} from '@/app/collab/authority/AuthorityKeysetPage';

function row(id: string, createdAt = '2026-08-08T00:00:00.000Z', body = 'x') {
  return { body, createdAt, id };
}

function keyOf(value: { createdAt: string; id: string }) {
  return { createdAt: value.createdAt, id: value.id };
}

describe('AuthorityKeysetPage', () => {
  it('round-trips a keyset cursor and rejects malformed input', () => {
    const cursor = { createdAt: '2026-08-08T00:00:00.000Z', id: 'comment-1' };
    expect(decodeAuthorityKeysetCursor(
      encodeAuthorityKeysetCursor(cursor),
      'test-cursor-invalid',
    )).toEqual(cursor);
    expect(decodeAuthorityKeysetCursor(undefined, 'test-cursor-invalid')).toBeUndefined();

    for (const value of [
      '',
      'not base64 json',
      Buffer.from('"scalar"', 'utf8').toString('base64url'),
      Buffer.from('{"createdAt":"not-a-date","id":"x"}', 'utf8').toString('base64url'),
      Buffer.from('{"createdAt":"2026-08-08T00:00:00.000Z"}', 'utf8').toString('base64url'),
      'c'.repeat(513),
    ]) {
      expect(() => decodeAuthorityKeysetCursor(value, 'test-cursor-invalid'))
        .toThrow('collab.error.protocol-payload-invalid');
    }
  });

  it('pages by count with a cursor only while rows remain', () => {
    const rows = ['a', 'b', 'c'].map(id => row(id));
    const first = trimAuthorityKeysetPage(rows, 2, 48 * 1024, keyOf);
    expect(first.items.map(item => item.id)).toEqual(['a', 'b']);
    expect(first.nextCursor).toBeDefined();
    const second = trimAuthorityKeysetPage(rows.slice(2), 2, 48 * 1024, keyOf);
    expect(second.items.map(item => item.id)).toEqual(['c']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('trims pages to the UTF-8 byte budget with multibyte content', () => {
    // '€' is 3 UTF-8 bytes: each row serializes well beyond its UTF-16 length.
    const rows = ['a', 'b', 'c', 'd'].map(id => row(id, '2026-08-08T00:00:00.000Z', '€'.repeat(20)));
    const secondCursor = encodeAuthorityKeysetCursor(keyOf(rows[1]!));
    const exactTwoItemPageBytes = Buffer.byteLength(JSON.stringify({
      items: rows.slice(0, 2),
      nextCursor: secondCursor,
    }), 'utf8');
    const page = trimAuthorityKeysetPage(rows, 4, exactTwoItemPageBytes, keyOf);
    expect(page.items.map(item => item.id)).toEqual(['a', 'b']);
    expect(page.nextCursor).toBeDefined();

    const decoded = decodeAuthorityKeysetCursor(page.nextCursor, 'test');
    expect(decoded).toEqual({ createdAt: rows[1].createdAt, id: 'b' });
  });

  it('measures escaped JSON serialization, not raw content', () => {
    // Quotes and newlines inflate on the wire: a two-character body can cost
    // six serialized bytes. The budget must count the escaped form.
    const rows = ['a', 'b', 'c'].map(id => row(id, '2026-08-08T00:00:00.000Z', '\n"'));
    const singleBytes = Buffer.byteLength(JSON.stringify(rows[0]), 'utf8');
    expect(singleBytes).toBeGreaterThan(Buffer.byteLength(rows[0]!.body, 'utf8'));
    const exactOneItemPageBytes = Buffer.byteLength(JSON.stringify({
      items: rows.slice(0, 1),
      nextCursor: encodeAuthorityKeysetCursor(keyOf(rows[0]!)),
    }), 'utf8');
    const page = trimAuthorityKeysetPage(rows, 2, exactOneItemPageBytes, keyOf);
    expect(page.items.map(item => item.id)).toEqual(['a']);
    expect(page.nextCursor).toBeDefined();
  });

  it('keeps the final page wrapper and generated cursor inside the byte budget', () => {
    const rows = ['a', 'b', 'c'].map(id => row(
      id,
      '2026-08-08T00:00:00.000Z',
      '\u0001'.repeat(30),
    ));
    const itemArrayBytes = Buffer.byteLength(JSON.stringify(rows.slice(0, 2)), 'utf8');
    const page = trimAuthorityKeysetPage(rows, 2, itemArrayBytes, keyOf);
    const finalPage = {
      items: page.items,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };

    expect(page.items).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(finalPage), 'utf8'))
      .toBeLessThanOrEqual(itemArrayBytes);
  });

  it('encodes cursors through a caller-owned codec when provided', () => {
    const rows = ['a', 'b', 'c'].map(id => row(id));
    const page = trimAuthorityKeysetPage(
      rows,
      2,
      48 * 1024,
      keyOf,
      key => `custom:${key.id}`,
    );
    expect(page.items.map(item => item.id)).toEqual(['a', 'b']);
    expect(page.nextCursor).toBe('custom:b');
  });

  it('always includes the first row even at the exact byte boundary', () => {
    const rows = [row('a'), row('b'), row('c')];
    const exactBytes = Buffer.byteLength(JSON.stringify({
      items: rows.slice(0, 1),
      nextCursor: encodeAuthorityKeysetCursor(keyOf(rows[0]!)),
    }), 'utf8');
    const page = trimAuthorityKeysetPage(rows, 2, exactBytes, keyOf);
    expect(page.items.map(item => item.id)).toEqual(['a']);
    expect(page.nextCursor).toBeDefined();
  });

  it('keeps one maximal JSON-escaped comment inside the shared page budget', () => {
    const maximal = row(
      'maximal',
      '2026-08-08T00:00:00.000Z',
      '\u0001'.repeat(COLLAB_LIMITS.maxTicketCommentBytes),
    );
    const page = trimAuthorityKeysetPage(
      [maximal, { ...maximal, id: 'next' }],
      2,
      COLLAB_LIMITS.commentPageMaxUtf8Bytes,
      keyOf,
    );

    expect(page.items).toEqual([maximal]);
    expect(Buffer.byteLength(JSON.stringify(page.items), 'utf8'))
      .toBeLessThanOrEqual(COLLAB_LIMITS.commentPageMaxUtf8Bytes);
    expect(page.nextCursor).toBeDefined();
  });

  describe('authorityDetailPageBudgets', () => {
    const {
      commentPageMaxUtf8Bytes,
      detailMaxUtf8Bytes,
      relationPageMaxUtf8Bytes,
    } = COLLAB_LIMITS;

    it('splits the remainder after the fixed detail between comments and relations', () => {
      const fixedUtf8Bytes = 8 * 1024;
      const budgets = authorityDetailPageBudgets(fixedUtf8Bytes, true);

      expect(budgets.commentsMaxUtf8Bytes).toBeLessThanOrEqual(commentPageMaxUtf8Bytes);
      expect(budgets.relationsMaxUtf8Bytes).toBeLessThanOrEqual(relationPageMaxUtf8Bytes);
      // The point of the helper: fixed part plus both embedded pages always
      // stay inside the shared detail bound.
      expect(
        fixedUtf8Bytes + budgets.commentsMaxUtf8Bytes + budgets.relationsMaxUtf8Bytes,
      ).toBeLessThanOrEqual(detailMaxUtf8Bytes);
    });

    it('never budgets below one maximal comment and one relation per embedded page', () => {
      const budgets = authorityDetailPageBudgets(detailMaxUtf8Bytes, true);

      expect(budgets.commentsMaxUtf8Bytes)
        .toBeGreaterThanOrEqual(COLLAB_LIMITS.maxTicketCommentBytes);
      expect(budgets.relationsMaxUtf8Bytes).toBeGreaterThanOrEqual(1024);
    });

    it('gives the whole remainder to comments when the detail has no relation page', () => {
      const fixedUtf8Bytes = 16 * 1024;
      const budgets = authorityDetailPageBudgets(fixedUtf8Bytes, false);

      expect(budgets.relationsMaxUtf8Bytes).toBe(0);
      expect(budgets.commentsMaxUtf8Bytes).toBeLessThanOrEqual(commentPageMaxUtf8Bytes);
      expect(fixedUtf8Bytes + budgets.commentsMaxUtf8Bytes)
        .toBeLessThanOrEqual(detailMaxUtf8Bytes);
    });
  });
});
