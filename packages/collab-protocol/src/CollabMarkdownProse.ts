import { parser } from '@lezer/markdown';

const MASKED_MARKDOWN_NODES = new Set([
  'CodeBlock',
  'Comment',
  'CommentBlock',
  'FencedCode',
  'HTMLBlock',
  'HTMLTag',
  'Image',
  'InlineCode',
  'LinkLabel',
  'LinkReference',
  'LinkTitle',
  'ProcessingInstruction',
  'ProcessingInstructionBlock',
  'URL',
]);

const BOUNDARY_MASKED_MARKDOWN_NODES = new Set(['Entity']);

interface MarkdownRange {
  readonly from: number;
  readonly to: number;
  readonly preservesBoundary?: boolean;
}

export function maskCollabMarkdownProse(markdown: string): string {
  const maskedRanges: MarkdownRange[] = [];
  const escapes: MarkdownRange[] = [];
  parser.parse(markdown).iterate({
    enter(node) {
      if (node.name === 'Escape') {
        escapes.push({ from: node.from, to: node.to });
        return false;
      }
      if (
        MASKED_MARKDOWN_NODES.has(node.name)
        || BOUNDARY_MASKED_MARKDOWN_NODES.has(node.name)
      ) {
        maskedRanges.push({
          from: node.from,
          preservesBoundary: BOUNDARY_MASKED_MARKDOWN_NODES.has(node.name),
          to: node.to,
        });
        return false;
      }
      return true;
    },
  });

  const output = markdown.split('');
  for (const range of maskedRanges) {
    for (let offset = range.from; offset < range.to; offset += 1) {
      if (markdown[offset] !== '\n' && markdown[offset] !== '\r') {
        output[offset] = range.preservesBoundary ? '_' : ' ';
      }
    }
  }
  for (const escape of escapes) {
    const escaped = markdown.slice(escape.from + 1, escape.to);
    output[escape.from] = ' ';
    output[escape.from + 1] = escaped === '@' || escaped === '#' ? '_' : escaped;
  }
  return output.join('');
}
