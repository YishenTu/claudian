import type { MarkdownRenderer } from 'obsidian';

/** Explicit host HTML simulation for escaping/trusted-insertion boundary tests. */
export const renderObsidianHTML: typeof MarkdownRenderer.render = async (_app, markdown, element) => {
  element.innerHTML = markdown;
};
