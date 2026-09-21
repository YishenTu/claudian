import type { DiffLine } from '@/core/types';
import {
  createAiEditReviewAnchor,
  createAiEditReviewSpecs,
  resolveAiEditReview,
} from '@/features/ai-edit-highlights/AiEditHighlightRanges';

describe('AI edit review range resolution', () => {
  it('keeps original and replacement text in one modified review', () => {
    const diffLines: DiffLine[] = [
      { type: 'equal', text: 'Before', oldLineNum: 4, newLineNum: 4 },
      { type: 'delete', text: 'Old value', oldLineNum: 5 },
      { type: 'insert', text: 'New value', newLineNum: 5 },
      { type: 'equal', text: 'After', oldLineNum: 6, newLineNum: 6 },
    ];

    const [spec] = createAiEditReviewSpecs(diffLines);
    expect(spec).toEqual({
      kind: 'modified',
      originalLines: ['Old value'],
      currentLines: ['New value'],
      beforeText: 'Before',
      afterText: 'After',
      hintedLine: 5,
    });
    expect(resolveAiEditReview('Intro\nBefore\nNew value\nAfter', spec)).toEqual({
      ...spec,
      kind: 'modified',
      fromLine: 3,
      toLine: 3,
    });
  });

  it('resolves a deletion to the boundary between surviving context lines', () => {
    const diffLines: DiffLine[] = [
      { type: 'equal', text: 'Before', oldLineNum: 1, newLineNum: 1 },
      { type: 'delete', text: 'Removed', oldLineNum: 2 },
      { type: 'equal', text: 'After', oldLineNum: 3, newLineNum: 2 },
    ];

    const [spec] = createAiEditReviewSpecs(diffLines);
    expect(spec).toMatchObject({
      kind: 'deleted',
      originalLines: ['Removed'],
      currentLines: [],
    });
    expect(resolveAiEditReview('Before\nAfter', spec)).toEqual({
      ...spec,
      kind: 'deleted',
      insertionAfterLine: 1,
    });
  });

  it('does not attach a deletion to an arbitrary repeated context line', () => {
    const [spec] = createAiEditReviewSpecs([
      { type: 'equal', text: 'Repeated', oldLineNum: 1, newLineNum: 1 },
      { type: 'delete', text: 'Removed', oldLineNum: 2 },
    ]);

    expect(resolveAiEditReview('Repeated\nMiddle\nRepeated', spec)).toBeNull();
  });

  it('uses both unchanged context lines to disambiguate repeated replacement text', () => {
    const [spec] = createAiEditReviewSpecs([
      { type: 'equal', text: 'Target heading', oldLineNum: 10, newLineNum: 10 },
      { type: 'delete', text: 'Old value', oldLineNum: 11 },
      { type: 'insert', text: 'Repeated value', newLineNum: 11 },
      { type: 'equal', text: 'Target footer', oldLineNum: 12, newLineNum: 12 },
    ]);

    expect(resolveAiEditReview(
      'Other heading\nRepeated value\nOther footer\nTarget heading\nRepeated value\nTarget footer',
      spec,
    )).toMatchObject({ fromLine: 5, toLine: 5, kind: 'modified' });
  });

  it('omits ambiguous repeated replacement text without unchanged context', () => {
    const [spec] = createAiEditReviewSpecs([
      { type: 'delete', text: 'Old value', oldLineNum: 1 },
      { type: 'insert', text: 'Repeated value', newLineNum: 1 },
    ]);

    expect(resolveAiEditReview('Repeated value\nMiddle\nRepeated value', spec)).toBeNull();
  });

  it('uses an exact document line hint to resolve repeated modified content', () => {
    const [spec] = createAiEditReviewSpecs([
      { type: 'delete', text: 'Old value', oldLineNum: 3 },
      { type: 'insert', text: 'Repeated value', newLineNum: 3 },
    ], { lineNumbersAreDocumentRelative: true });

    expect(resolveAiEditReview('Repeated value\nMiddle\nRepeated value', spec))
      .toMatchObject({ fromLine: 3, toLine: 3, kind: 'modified' });
  });

  it('uses an exact document line hint for a context-free deletion', () => {
    const [spec] = createAiEditReviewSpecs([
      { type: 'delete', text: 'Removed value', oldLineNum: 3 },
    ], { lineNumbersAreDocumentRelative: true });

    expect(resolveAiEditReview('First\nSecond\nFourth', spec))
      .toMatchObject({ insertionAfterLine: 2, kind: 'deleted' });
  });

  it('keeps concatenated multi-edit replacement pairs separate', () => {
    const specs = createAiEditReviewSpecs([
      { type: 'delete', text: 'First old', oldLineNum: 1 },
      { type: 'insert', text: 'First new', newLineNum: 1 },
      { type: 'delete', text: 'Second old', oldLineNum: 2 },
      { type: 'insert', text: 'Second new', newLineNum: 2 },
    ]);

    expect(specs).toHaveLength(2);
    expect(resolveAiEditReview('First new\nMiddle\nSecond new', specs[0]))
      .toMatchObject({ fromLine: 1, toLine: 1, kind: 'modified' });
    expect(resolveAiEditReview('First new\nMiddle\nSecond new', specs[1]))
      .toMatchObject({ fromLine: 3, toLine: 3, kind: 'modified' });
  });

  it('reattaches a shifted repeated review with W3C position and quote selectors', () => {
    const document = [
      'Section A',
      'Shared before',
      'Repeated value',
      'Shared after',
      'Divider',
      'Section B 😀',
      'Shared before',
      'Repeated value',
      'Shared after',
    ].join('\n');
    const spec = {
      kind: 'modified' as const,
      originalLines: ['Old value'],
      currentLines: ['Repeated value'],
      hintedLine: 8,
      hintedLineIsExact: true,
    };
    const resolved = resolveAiEditReview(document, spec)!;
    const anchor = createAiEditReviewAnchor(document, resolved);

    expect(anchor.position).toMatchObject({ type: 'TextPositionSelector' });
    expect(anchor.quote).toMatchObject({
      type: 'TextQuoteSelector',
      exact: 'Repeated value',
    });
    // W3C positions count Unicode code points, not JavaScript UTF-16 code units.
    expect(anchor.position.start).toBe([...document.slice(0, document.lastIndexOf('Repeated value'))].length);

    const shifted = `Inserted heading\n${document}`;
    expect(resolveAiEditReview(shifted, { ...spec, anchor })).toMatchObject({
      fromLine: 9,
      toLine: 9,
      kind: 'modified',
    });
  });

  it('reattaches an ambiguous deletion boundary with longer W3C quote context', () => {
    const document = [
      'Section A',
      'Shared before',
      'Shared after',
      'Divider',
      'Section B',
      'Shared before',
      'Shared after',
    ].join('\n');
    const spec = {
      kind: 'deleted' as const,
      originalLines: ['Removed value'],
      currentLines: [],
      beforeText: 'Shared before',
      afterText: 'Shared after',
      hintedInsertionAfterLine: 6,
    };
    const resolved = resolveAiEditReview(document, spec)!;
    const anchor = createAiEditReviewAnchor(document, resolved);
    const withoutPositionHint = {
      ...spec,
      hintedInsertionAfterLine: undefined,
      anchor: {
        ...anchor,
        position: { ...anchor.position, start: 0, end: 0 },
      },
    };

    expect(resolveAiEditReview(document, withoutPositionHint)).toMatchObject({
      insertionAfterLine: 6,
      kind: 'deleted',
    });
    const changedPrefix = document.replace('Section B', 'Renamed Section');
    expect(resolveAiEditReview(changedPrefix, { ...spec, anchor })).toMatchObject({
      insertionAfterLine: 6,
      kind: 'deleted',
    });
  });
});
