/** @jest-environment jsdom */

import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('ask-user-question.css', () => {
  it('keeps a hidden inline prompt out of layout', () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(path.resolve('src/style/features/ask-user-question.css'), 'utf8');
    document.head.appendChild(style);
    const prompt = document.createElement('div');
    prompt.className = 'claudian-ask-question-inline';
    prompt.hidden = true;
    document.body.appendChild(prompt);
    try {
      expect(window.getComputedStyle(prompt).display).toBe('none');
    } finally {
      prompt.remove();
      style.remove();
    }
  });
});
