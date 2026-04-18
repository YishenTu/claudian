export interface LineRangeMention {
  startLine: number;
  endLine: number;
}

export async function resolveLineRangeMentions(
  prompt: string,
  lineRangeMentions: Map<string, LineRangeMention>,
  readFile: (filePath: string) => Promise<string>,
): Promise<string> {
  if (lineRangeMentions.size === 0) return prompt;

  const blocks: string[] = [];

  for (const [filePath, { startLine, endLine }] of lineRangeMentions) {
    let content: string;
    try {
      content = await readFile(filePath);
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    const clampedEnd = Math.min(endLine, lines.length);
    const selectedLines = lines.slice(startLine - 1, clampedEnd);
    const selectedText = selectedLines.join('\n');

    blocks.push(
      `<editor_selection path="${filePath}" lines="${startLine}-${clampedEnd}">\n${selectedText}\n</editor_selection>`
    );
  }

  if (blocks.length === 0) return prompt;
  return `${prompt}\n\n${blocks.join('\n\n')}`;
}
