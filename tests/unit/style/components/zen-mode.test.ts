/** @jest-environment jsdom */

import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('Zen mode styles', () => {
  const css = [
    'src/style/base/visibility.css',
    'src/style/base/container.css',
    'src/style/components/context-tray.css',
    'src/style/components/zen-mode.css',
  ]
    .map(file => readFileSync(path.resolve(file), 'utf8'))
    .join('\n');

  afterEach(() => {
    document.head.querySelector('[data-testid="zen-styles"]')?.remove();
    document.body.replaceChildren();
  });

  function renderPanel(): HTMLElement {
    const style = document.createElement('style');
    style.dataset.testid = 'zen-styles';
    style.textContent = css;
    document.head.appendChild(style);

    document.body.innerHTML = `
      <div class="workspace-split mod-root claudian-zen-host">
        <div class="view-content">
          <div class="markdown-source-view mod-cm6"><div class="cm-editor"><div class="cm-scroller"></div></div></div>
          <div class="markdown-preview-view"></div>
        </div>
        <div class="claudian-container claudian-zen">
          <div class="claudian-zen-drawer">
            <div class="claudian-zen-history">
              <div class="claudian-messages-wrapper"><div class="claudian-messages"></div></div>
            </div>
            <div class="claudian-zen-bar">
              <button type="button" class="claudian-zen-disclosure claudian-hidden">
                <span class="claudian-zen-preview-icon" aria-hidden="true"></span>
                <span class="claudian-zen-preview"></span>
                <span class="claudian-zen-disclosure-icon" aria-hidden="true"></span>
              </button>
              <button type="button" class="claudian-zen-open"></button>
            </div>
          </div>
          <div class="claudian-zen-composer">
            <div class="claudian-input-wrapper">
              <div class="claudian-context-row has-content" data-context-slots="linked-content">
                <div class="claudian-context-chip" data-context-slot="linked-content"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    return document.querySelector('.claudian-zen') as HTMLElement;
  }

  it('lets the hidden state win over the disclosure control reset', () => {
    const panel = renderPanel();
    const disclosure = panel.querySelector('.claudian-zen-disclosure') as HTMLElement;
    expect(window.getComputedStyle(disclosure).display).toBe('none');

    disclosure.classList.remove('claudian-hidden');
    expect(window.getComputedStyle(disclosure).display).toBe('flex');
  });

  it('narrows the collapsible history and preview line relative to the composer', () => {
    const drawer = window.getComputedStyle(renderPanel().querySelector('.claudian-zen-drawer')!);
    expect({ width: drawer.width, alignSelf: drawer.alignSelf }).toEqual({ width: '90%', alignSelf: 'center' });
  });

  it.each([false, true])('opens the preview line and transcript into the composer border (expanded: %s)', (expanded) => {
    const panel = renderPanel();
    const drawer = panel.querySelector<HTMLElement>('.claudian-zen-drawer')!;
    panel.classList.toggle('claudian-zen--expanded', expanded);
    const style = window.getComputedStyle(drawer);
    expect({
      top: style.borderTop,
      left: style.borderLeft,
      right: style.borderRight,
      bottom: style.borderBottomStyle,
      radius: style.borderRadius,
    }).toEqual({
      top: '1px solid var(--background-modifier-border)',
      left: '1px solid var(--background-modifier-border)',
      right: '1px solid var(--background-modifier-border)',
      bottom: '',
      radius: 'var(--radius-l) var(--radius-l) 0 0',
    });
    // No gap, so the drawer's sides meet the composer's top border.
    expect(window.getComputedStyle(panel).gap).toBe('0');
    expect(window.getComputedStyle(panel.querySelector('.claudian-zen-history')!).borderStyle).toBe('');
  });

  it('hides the linked note badge, and its row when nothing else is attached', () => {
    const panel = renderPanel();
    const row = panel.querySelector<HTMLElement>('.claudian-context-row')!;
    const linked = row.querySelector<HTMLElement>('[data-context-slot="linked-content"]')!;
    expect(window.getComputedStyle(linked).display).toBe('none');
    expect(window.getComputedStyle(row).display).toBe('none');

    const image = row.createDiv({ cls: 'claudian-context-chip' });
    image.dataset.contextSlot = 'images';
    row.dataset.contextSlots = 'linked-content images';
    expect(window.getComputedStyle(row).display).toBe('flex');
    expect(window.getComputedStyle(image).display).toBe('inline-flex');
    expect(window.getComputedStyle(linked).display).toBe('none');
  });

  it('replaces the preview line with a downward chevron while expanded', () => {
    const panel = renderPanel();
    const preview = panel.querySelector('.claudian-zen-preview')!;
    const chevron = panel.querySelector('.claudian-zen-disclosure-icon')!;
    expect(window.getComputedStyle(chevron).display).toBe('none');
    expect(window.getComputedStyle(preview).display).not.toBe('none');

    const toolIcon = panel.querySelector('.claudian-zen-preview-icon')!;
    expect(window.getComputedStyle(toolIcon).display).toBe('flex');

    panel.classList.add('claudian-zen--expanded');
    expect(window.getComputedStyle(chevron).display).toBe('flex');
    expect(window.getComputedStyle(preview).display).toBe('none');
    expect(window.getComputedStyle(toolIcon).display).toBe('none');
    expect(window.getComputedStyle(panel.querySelector('.claudian-zen-disclosure')!).justifyContent).toBe('center');
  });

  it('suppresses Obsidian hover tooltips across the panel', () => {
    renderPanel();
    // Obsidian skips aria-label tooltips when the hovered element computes --no-tooltip to "true";
    // jsdom does not compute custom properties, so check the inherited declaration on the panel root.
    const sheet = document.head.querySelector<HTMLStyleElement>('[data-testid="zen-styles"]')!.sheet!;
    const root = Array.from(sheet.cssRules)
      .find((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && rule.selectorText === '.claudian-container.claudian-zen');
    expect(root?.style.getPropertyValue('--no-tooltip').trim()).toBe('true');
  });

  it('lets composer menus extend above the panel instead of clipping them to it', () => {
    expect(window.getComputedStyle(renderPanel()).overflow).toBe('visible');
  });

  it('keeps user bubbles clear of the transcript border', () => {
    const messages = window.getComputedStyle(renderPanel().querySelector('.claudian-messages')!);
    expect(messages.getPropertyValue('padding-inline-end')).toBe('14px');
  });

  it('pads the expandable header clear of the drawer border', () => {
    const bar = window.getComputedStyle(renderPanel().querySelector('.claudian-zen-bar')!);
    expect({ top: bar.paddingTop, right: bar.paddingRight, bottom: bar.paddingBottom, left: bar.paddingLeft })
      .toEqual({ top: '2px', right: '4px', bottom: '2px', left: '4px' });
  });

  it('gives the expandable header and open action no hover highlight', () => {
    renderPanel();
    const sheet = document.head.querySelector<HTMLStyleElement>('[data-testid="zen-styles"]')!.sheet!;
    const highlighted = Array.from(sheet.cssRules)
      .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
      .filter(rule => rule.selectorText.split(',').some(selector => /claudian-zen-(disclosure|open):hover/.test(selector)))
      .filter(rule => /--background-modifier-hover/.test(rule.style.cssText));
    expect(highlighted.map(rule => rule.selectorText)).toEqual([]);
  });

  it('draws no surface around the composer', () => {
    const panelStyle = window.getComputedStyle(renderPanel());
    expect({
      backgroundColor: panelStyle.backgroundColor,
      borderStyle: panelStyle.borderStyle,
      boxShadow: panelStyle.boxShadow,
    }).toEqual({ backgroundColor: 'rgba(0, 0, 0, 0)', borderStyle: '', boxShadow: '' });
  });

  // Nothing renders behind the panel, so translucent themes cannot show notes through it.
  it('reserves the panel height below the central workspace content', () => {
    const panel = renderPanel();
    expect(window.getComputedStyle(panel.parentElement!).paddingBottom)
      .toContain('var(--claudian-zen-reserved-height');
    for (const selector of ['.cm-scroller', '.markdown-preview-view']) {
      expect(window.getComputedStyle(panel.parentElement!.querySelector(selector)!).paddingBottom).toBe('');
    }
  });
});
