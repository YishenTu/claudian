import { parser } from '@lezer/markdown';

export interface CodeRange {
  from: number;
  to: number;
  lineStart?: number;
}

export function getCodexUserCodeRanges(text: string): CodeRange[] {
  const ranges: CodeRange[] = [];
  parser.parse(text).iterate({
    enter(node) {
      if (node.name === 'CodeBlock'
        || ((node.name === 'InlineCode' || node.name === 'FencedCode')
          && node.node.getChildren('CodeMark').length === 2)) {
        ranges.push({ from: node.from, to: node.to,
          ...(node.name === 'CodeBlock' ? { lineStart: text.lastIndexOf('\n', node.from - 1) + 1 } : {}),
        });
        return false;
      }
    },
  });
  return ranges;
}
