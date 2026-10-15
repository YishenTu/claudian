/** @jest-environment jsdom */

import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('inline-edit.css', () => {
  let style: HTMLStyleElement;

  beforeEach(() => {
    style = document.createElement('style');
    style.textContent = ['base/variables.css', 'features/inline-edit.css']
      .map(file => readFileSync(path.resolve('src/style', file), 'utf8'))
      .join('\n');
    document.head.appendChild(style);
  });

  afterEach(() => {
    document.body.replaceChildren();
    style.remove();
  });

  function mountComposer(providerId: string): HTMLElement {
    const container = document.createElement('div');
    container.className = 'claudian-inline-input-container';
    container.dataset.provider = providerId;
    container.innerHTML = '<div class="claudian-inline-input-wrap"><div class="claudian-inline-spinner"></div></div>';
    document.body.appendChild(container);
    return container;
  }

  it('spins in the Obsidian accent rather than the provider brand', () => {
    const spinner = mountComposer('claude').querySelector<HTMLElement>('.claudian-inline-spinner')!;

    expect(window.getComputedStyle(spinner).borderTopColor).toBe('var(--interactive-accent)');
  });

  it('colours the model chip logo for the provider running the edit', () => {
    const composer = mountComposer('deepseek');

    expect(window.getComputedStyle(composer).getPropertyValue('--claudian-provider-logo').trim())
      .toBe('var(--claudian-brand-deepseek)');
  });
});
