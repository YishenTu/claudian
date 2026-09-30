/** @jest-environment jsdom */

import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('Zen mode styles', () => {
  const css = [
    'src/style/base/visibility.css',
    'src/style/base/container.css',
    'src/style/components/input.css',
    'src/style/components/composer-editor.css',
    'src/style/components/context-tray.css',
    'src/style/components/context-footer.css',
    'src/style/toolbar/model-selector.css',
    'src/style/toolbar/thinking-selector.css',
    'src/style/components/side-chat.css',
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
              <button type="button" class="claudian-zen-disclosure">
                <span class="claudian-zen-preview-icon" aria-hidden="true"></span>
                <span class="claudian-zen-preview"></span>
              </button>
            </div>
          </div>
          <div class="claudian-zen-composer">
            <div class="claudian-input-wrapper">
              <div class="claudian-context-row has-content" data-context-slots="linked-content">
                <div class="claudian-context-chip" data-context-slot="linked-content"></div>
              </div>
              <div class="claudian-composer-editor">
                <div class="cm-content"><div class="cm-line"><span class="cm-placeholder">Ask</span></div></div>
              </div>
              <div class="claudian-input-toolbar">
                <div class="claudian-model-selector"><div class="claudian-model-dropdown"></div></div>
                <div class="claudian-thinking-selector">
                  <div class="claudian-thinking-effort">
                    <span class="claudian-thinking-label-text">Effort:</span>
                    <div class="claudian-thinking-gears"><div class="claudian-thinking-current">High</div></div>
                  </div>
                  <div class="claudian-thinking-budget">
                    <span class="claudian-thinking-label-text">Thinking:</span>
                  </div>
                  <div class="claudian-thinking-options"></div>
                </div>
                <div class="claudian-service-tier-toggle"></div>
                <div class="claudian-context-meter">
                  <div class="claudian-context-meter-gauge"></div>
                  <span class="claudian-context-meter-percent">42%</span>
                </div>
                <div class="claudian-permission-toggle"></div>
                <div class="claudian-mode-selector"></div>
              </div>
            </div>
          </div>
          <div class="claudian-zen-side-chat-chip-slot claudian-side-chat-chip-slot">
            <div class="claudian-side-chat"><div class="claudian-side-chat-status"></div></div>
          </div>
        </div>
      </div>
    `;
    return document.querySelector('.claudian-zen') as HTMLElement;
  }

  it('hides the whole drawer, open action included, while it is hidden', () => {
    const drawer = renderPanel().querySelector<HTMLElement>('.claudian-zen-drawer')!;
    expect(window.getComputedStyle(drawer).display).toBe('flex');

    drawer.classList.add('claudian-hidden');
    expect(window.getComputedStyle(drawer).display).toBe('none');
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

  it('drops the header line while expanded so the transcript meets the composer', () => {
    const panel = renderPanel();
    const bar = panel.querySelector('.claudian-zen-bar')!;
    expect(window.getComputedStyle(bar).display).toBe('flex');
    expect(window.getComputedStyle(panel.querySelector('.claudian-zen-preview-icon')!).display).toBe('flex');

    panel.classList.add('claudian-zen--expanded');
    expect(window.getComputedStyle(bar).display).toBe('none');
  });

  it('suppresses Obsidian hover tooltips across the panel except the context gauge', () => {
    renderPanel();
    // Obsidian skips aria-label tooltips when the hovered element computes --no-tooltip to "true";
    // jsdom does not compute custom properties, so check the inherited declaration on the panel root.
    const sheet = document.head.querySelector<HTMLStyleElement>('[data-testid="zen-styles"]')!.sheet!;
    const root = Array.from(sheet.cssRules)
      .find((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && rule.selectorText === '.claudian-container.claudian-zen');
    expect(root?.style.getPropertyValue('--no-tooltip').trim()).toBe('true');

    // The context gauge keeps its usage tooltip; it has no visible number in zen.
    const gauge = Array.from(sheet.cssRules)
      .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
      .filter(rule => rule.selectorText.split(',').some(selector => /\.claudian-context-meter\s*$/.test(selector.trim())))
      .map(rule => rule.style.getPropertyValue('--no-tooltip').trim())
      .filter(Boolean);
    expect(gauge).toEqual(['false']);
  });

  it('lets composer menus extend above the panel instead of clipping them to it', () => {
    expect(window.getComputedStyle(renderPanel()).overflow).toBe('visible');
  });

  it('keeps user bubbles clear of the transcript border', () => {
    const messages = window.getComputedStyle(renderPanel().querySelector('.claudian-messages')!);
    expect(messages.getPropertyValue('padding-inline-end')).toBe('14px');
  });

  it('keeps the transcript clear of the drawer border, outside its scroller', () => {
    const history = window.getComputedStyle(renderPanel().querySelector('.claudian-zen-history')!);
    expect({ top: history.paddingTop, bottom: history.paddingBottom }).toEqual({ top: '16px', bottom: '' });
  });

  it('pads the expandable header clear of the drawer border', () => {
    const bar = window.getComputedStyle(renderPanel().querySelector('.claudian-zen-bar')!);
    expect({ top: bar.paddingTop, right: bar.paddingRight, bottom: bar.paddingBottom, left: bar.paddingLeft })
      .toEqual({ top: '2px', right: '4px', bottom: '2px', left: '4px' });
  });

  it('gives the expandable header no hover highlight', () => {
    renderPanel();
    const sheet = document.head.querySelector<HTMLStyleElement>('[data-testid="zen-styles"]')!.sheet!;
    const highlighted = Array.from(sheet.cssRules)
      .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
      .filter(rule => rule.selectorText.split(',').some(selector => /claudian-zen-disclosure:hover/.test(selector)))
      .filter(rule => /--background-modifier-hover/.test(rule.style.cssText));
    expect(highlighted.map(rule => rule.selectorText)).toEqual([]);
  });

  it('shows only model, effort, fast mode and the context icon beside the input', () => {
    const composer = renderPanel().querySelector<HTMLElement>('.claudian-zen-composer')!;
    const wrapper = window.getComputedStyle(composer.querySelector('.claudian-input-wrapper')!);
    expect({ direction: wrapper.flexDirection, wrap: wrapper.flexWrap }).toEqual({ direction: 'row', wrap: 'wrap' });
    const display = (selector: string) => window.getComputedStyle(composer.querySelector(selector)!).display;

    expect(display('.claudian-input-toolbar')).toBe('flex');
    for (const shown of [
      '.claudian-model-selector', '.claudian-thinking-selector', '.claudian-service-tier-toggle',
      '.claudian-context-meter', '.claudian-context-meter-gauge', '.claudian-thinking-current',
    ]) {
      expect([shown, display(shown)]).not.toEqual([shown, 'none']);
    }
    for (const hidden of ['.claudian-permission-toggle', '.claudian-mode-selector', '.claudian-context-meter-percent']) {
      expect([hidden, display(hidden)]).toEqual([hidden, 'none']);
    }
    // Effort and budget show their value without the leading label.
    for (const label of composer.querySelectorAll('.claudian-thinking-label-text')) {
      expect(window.getComputedStyle(label).display).toBe('none');
    }
    expect(window.getComputedStyle(composer.querySelector('.claudian-input-toolbar')!).flexWrap).toBe('nowrap');
  });

  it('gives the input the whole row when the controls stack below it', () => {
    const composer = renderPanel().querySelector<HTMLElement>('.claudian-zen-composer')!;
    const editor = composer.querySelector('.claudian-composer-editor')!;
    expect(window.getComputedStyle(editor).flexBasis).not.toBe('100%');

    composer.classList.add('claudian-zen-composer--stacked');
    expect(window.getComputedStyle(editor).flexBasis).toBe('100%');
    expect(window.getComputedStyle(composer.querySelector('.claudian-input-toolbar')!).marginLeft).toBe('auto');
  });

  it('puts attachments on the controls row and raises the input above them', () => {
    const composer = renderPanel().querySelector<HTMLElement>('.claudian-zen-composer')!;
    const row = composer.querySelector<HTMLElement>('.claudian-context-row')!;
    const editor = composer.querySelector('.claudian-composer-editor')!;
    const style = (el: Element) => window.getComputedStyle(el);
    // Only the hidden linked note: the input keeps the controls beside it.
    expect(style(editor).flexBasis).not.toBe('100%');

    row.createDiv({ cls: 'claudian-context-chip' }).dataset.contextSlot = 'images';
    row.dataset.contextSlots = 'linked-content images';
    expect(style(editor).flexBasis).toBe('100%');
    const toolbar = composer.querySelector('.claudian-input-toolbar')!;
    // Input first, then attachments on the left and controls on the right of the next row.
    expect(['', '0']).toContain(style(editor).order);
    expect([style(row).order, style(toolbar).order]).toEqual(['1', '2']);

    // Attachments and controls center on their shared row, each with even vertical padding.
    expect(style(composer.querySelector('.claudian-input-wrapper')!).alignItems).toBe('center');
    for (const el of [row, toolbar]) {
      expect({ align: style(el).alignItems, top: style(el).paddingTop, bottom: style(el).paddingBottom })
        .toEqual({ align: 'center', top: '4px', bottom: '4px' });
    }
    expect({ grow: style(row).flexGrow, basis: style(row).flexBasis }).toEqual({ grow: '1', basis: '0px' });
  });

  it('aligns the controls with the first line of expanded attachments', () => {
    const composer = renderPanel().querySelector<HTMLElement>('.claudian-zen-composer')!;
    const row = composer.querySelector<HTMLElement>('.claudian-context-row')!;
    const toolbar = composer.querySelector<HTMLElement>('.claudian-input-toolbar')!;
    row.dataset.contextSlots = 'images';
    const style = (el: Element) => window.getComputedStyle(el);
    expect(style(toolbar).alignSelf).not.toBe('flex-start');

    row.classList.add('claudian-context-row--expanded');
    expect(style(toolbar).alignSelf).toBe('flex-start');
    // Same top edge and padding, and a control line as tall as one 24px chip line.
    const chip = style(row.querySelector('.claudian-context-chip')!);
    expect(style(toolbar).paddingTop).toBe(style(row).paddingTop);
    expect({ sizing: style(toolbar).boxSizing, minHeight: style(toolbar).minHeight, chip: chip.height })
      .toEqual({ sizing: 'border-box', minHeight: '32px', chip: '24px' });
  });

  it('centers control menus above their labels and keeps the placeholder on one line', () => {
    const composer = renderPanel().querySelector<HTMLElement>('.claudian-zen-composer')!;
    for (const selector of ['.claudian-model-dropdown', '.claudian-thinking-options']) {
      const menu = window.getComputedStyle(composer.querySelector(selector)!);
      expect([selector, menu.left, menu.right, menu.transform])
        .toEqual([selector, '50%', 'auto', 'translateX(-50%)']);
    }
    const placeholder = window.getComputedStyle(composer.querySelector('.cm-placeholder')!);
    expect({ whiteSpace: placeholder.whiteSpace, textOverflow: placeholder.textOverflow })
      .toEqual({ whiteSpace: 'nowrap', textOverflow: 'ellipsis' });
  });

  it('sets the collapsed side chip just below the composer, aligned with its padding', () => {
    const slot = renderPanel().querySelector<HTMLElement>('.claudian-zen-side-chat-chip-slot')!;
    const slotStyle = window.getComputedStyle(slot);
    const chip = window.getComputedStyle(slot.querySelector('.claudian-side-chat-status')!);
    expect({ top: slotStyle.paddingTop, left: slotStyle.paddingLeft, chipMargin: chip.marginBottom })
      .toEqual({ top: '4px', left: '6px', chipMargin: '0px' });

    slot.replaceChildren();
    expect(window.getComputedStyle(slot).display).toBe('none');
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
