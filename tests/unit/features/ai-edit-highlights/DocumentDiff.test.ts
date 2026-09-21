import { createAiEditReviewSpecs } from '@/features/ai-edit-highlights/AiEditHighlightRanges';
import {
  calculateDocumentDiff,
  createDocumentDiffData,
} from '@/features/ai-edit-highlights/DocumentDiff';

function numberedDocument(lineCount: number): string {
  return Array.from({ length: lineCount }, (_, index) => `Line ${index + 1}`).join('\n');
}

function replaceLines(text: string, replacements: ReadonlyMap<number, string>): string {
  return text.split('\n').map((line, index) => replacements.get(index + 1) ?? line).join('\n');
}

describe('DocumentDiff', () => {
  it.each([500, 501, 980])(
    'keeps sparse endpoint changes precise across a %i-line middle interval',
    intervalLength => {
      const lineCount = intervalLength + 20;
      const firstChangedLine = 10;
      const lastChangedLine = firstChangedLine + intervalLength - 1;
      const before = numberedDocument(lineCount);
      const after = replaceLines(before, new Map([
        [firstChangedLine, 'Revised first endpoint'],
        [lastChangedLine, 'Revised last endpoint'],
      ]));

      const diff = createDocumentDiffData('notes/large.md', before, after)!;
      const reviews = createAiEditReviewSpecs(diff.diffLines, {
        lineNumbersAreDocumentRelative: true,
      });

      expect(diff.stats).toEqual({ added: 2, removed: 2 });
      expect(reviews).toMatchObject([
        { hintedLine: firstChangedLine, originalLines: [`Line ${firstChangedLine}`], currentLines: ['Revised first endpoint'] },
        { hintedLine: lastChangedLine, originalLines: [`Line ${lastChangedLine}`], currentLines: ['Revised last endpoint'] },
      ]);
    },
  );

  it.each([
    { beforeCount: 500, afterCount: 501, inserted: true },
    { beforeCount: 501, afterCount: 500, inserted: false },
  ])('keeps an internal $inserted operation separate beyond the old LCS budget', ({
    beforeCount,
    afterCount,
    inserted,
  }) => {
    const shared = numberedDocument(499).split('\n');
    const beforeLines = [...shared];
    const afterLines = [...shared];
    beforeLines[0] = 'Old head';
    afterLines[0] = 'New head';
    beforeLines[beforeLines.length - 1] = 'Old tail';
    afterLines[afterLines.length - 1] = 'New tail';
    if (inserted) {
      beforeLines.push('Old final');
      afterLines.splice(250, 0, 'Inserted middle');
      afterLines.push('New final');
    } else {
      beforeLines.splice(250, 0, 'Deleted middle');
      beforeLines.push('Old final');
      afterLines.push('New final');
    }
    expect(beforeLines).toHaveLength(beforeCount);
    expect(afterLines).toHaveLength(afterCount);

    const diff = createDocumentDiffData('notes/unequal.md', beforeLines.join('\n'), afterLines.join('\n'))!;
    const reviews = createAiEditReviewSpecs(diff.diffLines, {
      lineNumbersAreDocumentRelative: true,
    });

    expect(reviews).toHaveLength(3);
    expect(reviews.filter(review => review.currentLines.includes('Inserted middle'))).toHaveLength(inserted ? 1 : 0);
    expect(reviews.filter(review => review.originalLines.includes('Deleted middle'))).toHaveLength(inserted ? 0 : 1);
    expect(reviews.reduce((sum, review) => sum + review.currentLines.length, 0)).toBe(inserted ? 4 : 3);
  });

  it('reports an explicit incomplete result instead of fabricating a whole-document replacement', () => {
    const before = Array.from({ length: 2_000 }, (_, index) => `Before ${index}`).join('\n');
    const after = Array.from({ length: 2_000 }, (_, index) => `After ${index}`).join('\n');

    expect(calculateDocumentDiff('notes/rewrite.md', before, after)).toEqual({ status: 'incomplete' });
  });

  it('keeps repeated unchanged lines anchored around the actual sparse edits', () => {
    const beforeLines = Array.from({ length: 700 }, () => '$$x^2$$');
    const afterLines = [...beforeLines];
    afterLines[49] = '$$x^3$$';
    afterLines[549] = '$$x^4$$';

    const diff = createDocumentDiffData(
      'notes/repeated.md',
      beforeLines.join('\r\n'),
      afterLines.join('\r\n'),
    )!;
    const reviews = createAiEditReviewSpecs(diff.diffLines, {
      lineNumbersAreDocumentRelative: true,
    });

    expect(reviews).toMatchObject([
      { hintedLine: 50, originalLines: ['$$x^2$$'], currentLines: ['$$x^3$$'] },
      { hintedLine: 550, originalLines: ['$$x^2$$'], currentLines: ['$$x^4$$'] },
    ]);
  });
});
