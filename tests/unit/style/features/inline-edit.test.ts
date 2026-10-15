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

  it('floats the model menu fixed above its chip, outside the clipped editor, in the provider colours', () => {
    document.body.innerHTML = '<div class="claudian-inline-menu-layer" data-provider="deepseek">'
      + '<div class="claudian-toolbar-popover claudian-toolbar-popover--floating"></div></div>';
    const menu = window.getComputedStyle(document.querySelector('.claudian-toolbar-popover')!);
    // jsdom does not inherit custom properties, so the layer the menu inherits from is read directly.
    const layer = window.getComputedStyle(document.querySelector('.claudian-inline-menu-layer')!);

    // ToolbarMenu sets the variable from the chip's position, so the menu opens upward from it.
    expect(menu.position).toBe('fixed');
    expect(menu.top).toBe('auto');
    expect(menu.bottom).toBe('var(--claudian-toolbar-popover-bottom)');
    expect(layer.getPropertyValue('--claudian-provider-logo').trim()).toBe('var(--claudian-brand-deepseek)');
  });

  it('keeps the review gutter bars inside the widget box, which Obsidian clips', () => {
    document.body.innerHTML = '<div class="claudian-inline-diff-preview"><div class="claudian-inline-diff-preview-body">'
      + '<div class="claudian-diff-block claudian-diff-del"></div></div></div>';

    for (const selector of ['.claudian-inline-diff-preview-body', '.claudian-diff-block']) {
      const style = window.getComputedStyle(document.querySelector(selector)!);
      // jsdom keeps logical margins as declared, so a negative bleed shows up as a minus sign.
      expect(`${style.marginLeft} ${style.getPropertyValue('margin-inline')}`).not.toMatch(/-\d/);
    }
  });

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
