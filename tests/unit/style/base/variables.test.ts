// @test-ci {"inputs":["src/style/**"]}
/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import path from 'node:path';

// Chat type sizes follow Obsidian's note font size (#2052). Inline edit and
// modals/settings own their own sizing and are outside this contract.
const CHAT_STYLE_MODULES = readFileSync(path.resolve('src/style/index.css'), 'utf8')
  .match(/@import url\("\.\/[^"]+"\)/g)!
  .map((line) => line.slice('@import url("./'.length, -2))
  .filter((module) => /^(components|toolbar)\//.test(module) || [
    'features/ask-user-question.css',
    'features/diff.css',
    'features/file-link.css',
    'features/image-context.css',
    'features/image-embed.css',
    'features/resume-session.css',
  ].includes(module));

describe('Chat type scale', () => {
  it.each(CHAT_STYLE_MODULES)('sizes %s text relative to the note font size', (module) => {
    const css = readFileSync(path.resolve('src/style', module), 'utf8');
    const fixedSizes = css.match(/(?:font-size|line-height):\s*(?:[0-9.]+px|var\(--font-ui-[a-z]+[^)]*\))/g) ?? [];

    expect(fixedSizes).toEqual([]);
  });

  // Session metadata popovers and inline-edit suggestions mount on document.body, outside chat containers.
  it('defines the scale on body beside the note font size', () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(path.resolve('src/style/base/variables.css'), 'utf8');
    document.head.appendChild(style);

    try {
      expect(window.getComputedStyle(document.body).getPropertyValue('--claudian-font-px').trim())
        .toBe('calc(var(--font-text-size) / 16)');
    } finally {
      style.remove();
    }
  });
});
