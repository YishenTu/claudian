/** @jest-environment jsdom */

import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('inline-edit.css', () => {
  let styles: HTMLStyleElement[] = [];

  beforeEach(() => {
    // One sheet per file, as the build concatenates them: jsdom drops the rest of a sheet after an
    // at-rule it cannot parse, such as model-selector.css's @container.
    styles = ['base/variables.css', 'toolbar/model-selector.css', 'features/inline-edit.css'].map((file) => {
      const style = document.createElement('style');
      style.textContent = readFileSync(path.resolve('src/style', file), 'utf8');
      document.head.appendChild(style);
      return style;
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    for (const style of styles) style.remove();
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

  it('opens the model menu upward, away from the selected text below the composer', () => {
    const composer = mountComposer('claude');
    composer.querySelector('.claudian-inline-input-wrap')!.insertAdjacentHTML(
      'beforeend',
      '<div class="claudian-input-toolbar claudian-inline-model-toolbar"><div class="claudian-toolbar-chip-anchor">'
        + '<div class="claudian-toolbar-popover"></div></div></div>',
    );
    const menu = window.getComputedStyle(composer.querySelector('.claudian-toolbar-popover')!);

    expect(menu.bottom).not.toBe('auto');
    expect(menu.top).not.toMatch(/100%/);
  });

  it.each(['claudian-inline-input-container', 'claudian-inline-diff-preview'])(
    'lets the %s widget paint outside its box despite Obsidian containing editor widgets',
    (widgetClass) => {
      // Obsidian app.css: block widgets are non-editable children of .cm-content and get paint containment,
      // which would clip the model menu and the review's gutter bars. It loads before plugin styles;
      // jsdom cascades sheets in insertion order, so the plugin sheets are re-inserted after it.
      const host = document.createElement('style');
      host.textContent = '.markdown-source-view.mod-cm6 .cm-content > [contenteditable=false] { contain: paint !important; }';
      document.head.appendChild(host);
      for (const style of styles) document.head.appendChild(style);
      styles.push(host);
      document.body.innerHTML = '<div class="markdown-source-view mod-cm6"><div class="cm-content">'
        + `<div class="${widgetClass}" contenteditable="false"></div></div></div>`;
      const widget = document.querySelector(`.${widgetClass}`)!;

      expect(window.getComputedStyle(widget).getPropertyValue('contain')).toBe('none');
    },
  );

  it('separates the composer from the selected text below with padding, since Obsidian zeroes widget margins', () => {
    const host = document.createElement('style');
    host.textContent = '.markdown-source-view.mod-cm6 .cm-content > * { margin: 0 !important; }';
    document.head.appendChild(host);
    for (const style of styles) document.head.appendChild(style);
    styles.push(host);
    document.body.innerHTML = '<div class="markdown-source-view mod-cm6"><div class="cm-content">'
      + '<div class="claudian-inline-input-container" contenteditable="false"></div></div></div>';
    const composer = window.getComputedStyle(document.querySelector('.claudian-inline-input-container')!);

    expect(parseFloat(composer.marginBottom || '0') + parseFloat(composer.paddingBottom || '0')).toBeGreaterThanOrEqual(8);
  });
});
