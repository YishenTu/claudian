/** @jest-environment jsdom */

import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('Composer input styles', () => {
  const css = [
    'src/style/components/input.css',
    'src/style/components/composer-editor.css',
    'src/style/components/composer-info-row.css',
    'src/style/components/context-footer.css',
    'src/style/toolbar/model-selector.css',
    'src/style/toolbar/permission-toggle.css',
    'src/style/base/visibility.css',
  ]
    .map(file => readFileSync(path.resolve(file), 'utf8'))
    .join('\n');

  afterEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
  });

  function renderComposer(): HTMLElement {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    document.body.innerHTML = `
      <div class="claudian-input-composer">
        <div class="claudian-input-container">
          <div class="claudian-input-nav-row"></div>
          <div class="claudian-input-wrapper">
            <div class="claudian-input-queue-strip claudian-hidden"></div>
            <div class="claudian-context-row"></div>
            <div class="claudian-composer-editor"><div class="cm-content"></div></div>
            <div class="claudian-input-toolbar">
              <div class="claudian-toolbar-chip-anchor claudian-toolbar-chip-anchor--model"></div>
              <div class="claudian-context-meter"><span class="claudian-context-meter-percent">42%</span></div>
              <div class="claudian-toolbar-chip-anchor claudian-permission-toggle">
                <div class="claudian-toolbar-popover"></div>
              </div>
            </div>
          </div>
          <div class="claudian-input-info-row">
            <div class="claudian-input-info-linked"></div>
          </div>
        </div>
      </div>
    `;
    return document.querySelector('.claudian-input-composer') as HTMLElement;
  }

  const style = (el: Element) => window.getComputedStyle(el);

  it('sizes the idle input box from its content instead of a fixed floor', () => {
    const composer = renderComposer();
    const wrapper = style(composer.querySelector('.claudian-input-wrapper')!);
    expect(['', '0', '0px', 'auto']).toContain(wrapper.minHeight);
    expect(wrapper.flexDirection).toBe('column');
    // About two lines of text before the toolbar.
    expect(style(composer.querySelector('.claudian-composer-editor')!).minHeight).toBe('48px');
    expect(style(composer.querySelector('.cm-content')!).minHeight).toBe('48px');
  });

  it('insets the hint and text like the toolbar content, with room above the first line', () => {
    const composer = renderComposer();
    const content = style(composer.querySelector('.cm-content')!);
    // More room above than below: the toolbar under the text already adds space.
    expect([content.paddingTop, content.paddingBottom]).toEqual(['12px', '2px']);
    const line = document.createElement('div');
    line.className = 'cm-line';
    composer.querySelector('.cm-content')!.appendChild(line);
    // 13px lines text up with the model chip's icon (6px toolbar padding + 7px chip padding).
    expect([style(line).paddingLeft, style(line).paddingRight]).toEqual(['13px', '13px']);
  });

  it('lays a wrapped hint out inline, so the caret beside it stays one line tall', () => {
    const composer = renderComposer();
    const hint = document.createElement('span');
    hint.className = 'cm-placeholder';
    composer.querySelector('.cm-content')!.appendChild(hint);
    // CodeMirror's default inline-block makes the native caret as tall as the whole wrapped hint.
    expect(style(hint).display).toBe('inline');
  });

  it('keeps the input box unfilled, as before the redesign, and sizes toolbar labels from it', () => {
    const wrapper = style(renderComposer().querySelector('.claudian-input-wrapper')!);
    expect(['', 'rgba(0, 0, 0, 0)', 'transparent']).toContain(wrapper.getPropertyValue('background-color'));
    // The box, not the shrink-wrapped toolbar, is the size container for narrow-width labels.
    expect(wrapper.getPropertyValue('container-type')).toBe('inline-size');
    expect(css).not.toContain('claudian-input-toolbar--compact');
  });

  it('shows the queued-message strip only while visible, as a cap on the input box', () => {
    const strip = renderComposer().querySelector<HTMLElement>('.claudian-input-queue-strip')!;
    expect(style(strip).display).toBe('none');
    strip.classList.replace('claudian-hidden', 'claudian-visible-flex');
    expect(style(strip).display).toBe('flex');
    // jsdom does not compute border longhands, so read the strip's own declaration.
    const rule = Array.from(document.head.querySelector('style')!.sheet!.cssRules)
      .find((candidate): candidate is CSSStyleRule => (
        candidate instanceof CSSStyleRule && candidate.selectorText === '.claudian-input-queue-strip'
      ))!;
    expect(rule.style.getPropertyValue('border-bottom')).toBe('1px solid var(--background-modifier-border)');
    // Its top corners follow the box's inner radius, so it reads as part of the box.
    expect(rule.style.getPropertyValue('border-radius'))
      .toBe('calc(var(--claudian-input-wrapper-radius) - 1px) calc(var(--claudian-input-wrapper-radius) - 1px) 0 0');
  });

  it('gives every composer button outside the toolbar a visible keyboard focus outline', () => {
    renderComposer();
    const rules = Array.from(document.head.querySelector('style')!.sheet!.cssRules)
      .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule);
    for (const control of [
      'claudian-input-info-linked-main',
      'claudian-input-info-linked-remove',
      'claudian-queue-indicator-action',
      'claudian-queue-indicator-icon-action',
    ]) {
      const outline = rules
        .filter(rule => rule.selectorText.split(',').some(selector => (
          selector.includes(':focus-visible')
          && (selector.includes(control) || selector.includes('.claudian-input-info-linked > button:focus-visible'))
        )))
        .map(rule => rule.style.getPropertyValue('outline'))
        .find(Boolean);
      expect([control, outline]).toEqual([control, '2px solid var(--interactive-accent)']);
    }
  });

  it('pushes the permission control to the far end of the toolbar, its menu opening end-aligned', () => {
    const composer = renderComposer();
    const anchor = composer.querySelector('.claudian-permission-toggle')!;
    expect(style(anchor).getPropertyValue('margin-inline-start')).toBe('auto');
    const popover = style(anchor.querySelector('.claudian-toolbar-popover')!);
    expect([popover.getPropertyValue('inset-inline-start'), popover.getPropertyValue('inset-inline-end')]).toEqual(['auto', '0']);
  });

  it('keeps the usage number close to its gauge icon', () => {
    const meter = renderComposer().querySelector('.claudian-context-meter')!;
    // The 16px icon sits centred in a 24px gauge; its 4px inset plus this gap leaves 6px before the number.
    expect(style(meter).gap).toBe('2px');
    // Width reserved for longer numbers goes after the number, not between it and the icon.
    expect(style(meter.querySelector('.claudian-context-meter-percent')!).textAlign).toBe('start');
  });

  it('lays the info row out borderless under the box', () => {
    const composer = renderComposer();
    const row = composer.querySelector<HTMLElement>('.claudian-input-info-row')!;
    expect(row.parentElement).toBe(composer.querySelector('.claudian-input-container'));
    expect(style(row).display).toBe('flex');
    expect(style(row).borderStyle).toBe('');

    // Collapsing takes no height.
    row.classList.add('claudian-hidden');
    expect(style(row).display).toBe('none');
  });
});
