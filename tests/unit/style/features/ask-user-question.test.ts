/** @jest-environment jsdom */

import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('ask-user-question.css', () => {
  let style: HTMLStyleElement;

  beforeEach(() => {
    style = document.createElement('style');
    style.textContent = readFileSync(path.resolve('src/style/features/ask-user-question.css'), 'utf8');
    document.head.appendChild(style);
  });

  afterEach(() => {
    document.body.replaceChildren();
    style.remove();
  });

  it('keeps a hidden inline prompt out of layout', () => {
    const prompt = document.createElement('div');
    prompt.className = 'claudian-ask-question-inline';
    prompt.hidden = true;
    document.body.appendChild(prompt);

    expect(window.getComputedStyle(prompt).display).toBe('none');
  });

  it('accents the custom-text underline only while the input has focus', () => {
    const prompt = document.createElement('div');
    prompt.className = 'claudian-ask-question-inline';
    const [focused, idle] = [0, 1].map(() => {
      const item = document.createElement('div');
      item.className = 'claudian-ask-item claudian-ask-custom-item';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'claudian-ask-custom-text';
      item.appendChild(input);
      prompt.appendChild(item);
      return input;
    });
    document.body.appendChild(prompt);

    // jsdom caches computed styles across focus changes, so read each input once.
    focused.focus();
    expect(document.activeElement).toBe(focused);
    expect(window.getComputedStyle(focused).borderBottomColor).toBe('var(--claudian-ask-accent)');
    expect(window.getComputedStyle(idle).borderBottomColor).not.toBe('var(--claudian-ask-accent)');
  });
});
