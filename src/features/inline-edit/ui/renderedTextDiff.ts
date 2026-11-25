import { alignLines } from '@/features/inline-edit/ui/markdownLineDiff';
import { computeBlockInlineDiffs, createInlineDiffBudget, type InlineDiffSegment } from '@/utils/inlineLineDiff';

/** Rendered elements whose own text the reader compares as one line. */
const TEXT_BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, td, th, pre, dt, dd, figcaption, .callout-title-inner';

/** Rendered content that is not comparable text: math, embeds, diagrams and controls. */
const SKIPPED_SELECTOR = '.math, mjx-container, svg, .internal-embed, .markdown-embed, .mermaid, button, script, style';

interface TextBlock {
  text: string;
  /** The block's own text nodes in order; `null` stands for a line break. */
  pieces: Array<Text | null>;
}

/**
 * Marks the changed characters and words between two rendered Markdown documents. Comparing the
 * rendered text rather than the source keeps every mark on text the reader sees: Markdown syntax
 * is gone after rendering, so changes to formatting alone leave the block unmarked.
 */
export function highlightRenderedTextChanges(oldRoot: HTMLElement, newRoot: HTMLElement): void {
  const oldBlocks = collectTextBlocks(oldRoot);
  const newBlocks = collectTextBlocks(newRoot);
  const runs = alignLines(oldBlocks.map(block => block.text), newBlocks.map(block => block.text));
  const budget = createInlineDiffBudget();
  let oldIndex = 0, newIndex = 0;
  for (let index = 0; index < runs.length; index++) {
    if (runs[index].type === 'equal') {
      oldIndex += runs[index].count;
      newIndex += runs[index].count;
      continue;
    }
    // Pair within the whole changed stretch between two unchanged blocks.
    let deleted = 0, inserted = 0;
    for (; index < runs.length && runs[index].type !== 'equal'; index++) {
      if (runs[index].type === 'delete') deleted += runs[index].count;
      else inserted += runs[index].count;
    }
    index--;
    const deletedBlocks = oldBlocks.slice(oldIndex, oldIndex + deleted);
    const insertedBlocks = newBlocks.slice(newIndex, newIndex + inserted);
    const { deleteSegments, insertSegments } = computeBlockInlineDiffs(
      deletedBlocks.map(block => block.text), insertedBlocks.map(block => block.text), budget,
    );
    deletedBlocks.forEach((block, i) => markChangedText(block, deleteSegments[i], 'claudian-diff-inline-delete'));
    insertedBlocks.forEach((block, i) => markChangedText(block, insertSegments[i], 'claudian-diff-inline-insert'));
    oldIndex += deleted;
    newIndex += inserted;
  }
}

function collectTextBlocks(root: HTMLElement): TextBlock[] {
  const blocks = new Map<Element, TextBlock>();
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const isText = node.nodeType === Node.TEXT_NODE;
    if (!isText && node.nodeName !== 'BR') continue;
    const parent = node.parentElement;
    if (!parent || parent.closest(SKIPPED_SELECTOR)) continue;
    const owner = parent.closest(TEXT_BLOCK_SELECTOR);
    const key = owner && root.contains(owner) ? owner : root;
    let block = blocks.get(key);
    if (!block) blocks.set(key, block = { text: '', pieces: [] });
    block.text += isText ? (node as Text).data : '\n';
    block.pieces.push(isText ? node as Text : null);
  }
  return Array.from(blocks.values()).filter(block => block.text.trim());
}

/** An unpaired block is marked whole; otherwise it would read like the unchanged blocks around it. */
function markChangedText(block: TextBlock, segments: InlineDiffSegment[] | null, cls: string): void {
  segments ??= [{ text: block.text, changed: true }];
  const ranges: Array<[number, number]> = [];
  let offset = 0;
  for (const segment of segments) {
    if (segment.changed) ranges.push([offset, offset + segment.text.length]);
    offset += segment.text.length;
  }

  let rangeIndex = 0;
  let start = 0;
  for (const piece of block.pieces) {
    const end = start + (piece ? piece.data.length : 1);
    while (rangeIndex < ranges.length && ranges[rangeIndex][1] <= start) rangeIndex++;
    if (piece) {
      // Marks belong to the preview's window, which may be a popout.
      const ownerWindow = piece.win as Window & { createSpan: typeof createSpan };
      // A change across formatting is marked separately inside each text node it covers.
      const parts: Array<string | Node> = [];
      let cursor = start;
      for (let i = rangeIndex; i < ranges.length && ranges[i][0] < end; i++) {
        const from = Math.max(ranges[i][0], start), to = Math.min(ranges[i][1], end);
        if (from > cursor) parts.push(piece.data.slice(cursor - start, from - start));
        parts.push(ownerWindow.createSpan({ cls, text: piece.data.slice(from - start, to - start) }));
        cursor = to;
      }
      if (parts.length > 0) {
        if (cursor < end) parts.push(piece.data.slice(cursor - start));
        piece.replaceWith(...parts);
      }
    }
    start = end;
  }
}
