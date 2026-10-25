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

  it('suppresses Obsidian hover tooltips across question and permission prompts', () => {
    const prompt = document.createElement('div');
    prompt.className = 'claudian-ask-question-inline';
    document.body.appendChild(prompt);

    // Obsidian skips aria-label tooltips when the hovered element inherits --no-tooltip: true.
    expect(window.getComputedStyle(prompt).getPropertyValue('--no-tooltip').trim()).toBe('true');
  });

  it('keeps a hidden inline prompt out of layout', () => {
    const prompt = document.createElement('div');
    prompt.className = 'claudian-ask-question-inline';
    prompt.hidden = true;
    document.body.appendChild(prompt);

    expect(window.getComputedStyle(prompt).display).toBe('none');
  });

  it('lets option text wrap instead of inheriting the host button nowrap', () => {
    // Obsidian's app.css sets `button { white-space: nowrap }`.
    const hostStyle = document.createElement('style');
    hostStyle.textContent = 'button { white-space: nowrap; }'
      + readFileSync(path.resolve('src/style/features/ask-user-question.css'), 'utf8');
    document.head.appendChild(hostStyle);

    const prompt = document.createElement('div');
    prompt.className = 'claudian-ask-question-inline';
    const item = document.createElement('button');
    item.className = 'claudian-ask-item';
    const content = document.createElement('span');
    content.className = 'claudian-ask-item-content';
    const desc = document.createElement('span');
    desc.className = 'claudian-ask-item-desc';
    desc.textContent = 'A description long enough to wrap inside the prompt width.';
    content.appendChild(desc);
    item.appendChild(content);
    prompt.appendChild(item);
    document.body.appendChild(prompt);

    try {
      expect(window.getComputedStyle(item).whiteSpace).toBe('normal');
      expect(window.getComputedStyle(desc).overflowWrap).toBe('anywhere');
    } finally {
      hostStyle.remove();
    }
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
