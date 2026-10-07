/** @jest-environment jsdom */

import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('Tool renderer hover tooltips', () => {
  it.each(['claudian-tool-header', 'claudian-write-edit-header'])('suppresses Obsidian tooltips on %s', (className) => {
    const style = document.createElement('style');
    style.textContent = readFileSync(path.resolve('src/style/components/toolcalls.css'), 'utf8');
    document.head.appendChild(style);
    const header = document.createElement('div');
    header.className = className;
    document.body.appendChild(header);

    try {
      // Obsidian checks this inherited property before showing aria-label tooltips.
      expect(getComputedStyle(header).getPropertyValue('--no-tooltip').trim()).toBe('true');
    } finally {
      header.remove();
      style.remove();
    }
  });
});
