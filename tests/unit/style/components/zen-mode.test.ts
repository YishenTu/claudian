/** @jest-environment jsdom */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { fireEvent, within } from '@testing-library/dom';

import { createInputToolbar } from '@/features/chat/composer/toolbar/InputToolbar';
import type { ToolbarCallbacks } from '@/features/chat/composer/toolbar/types';

beforeAll(() => {
  Object.assign(HTMLElement.prototype, {
    empty(this: HTMLElement) { this.replaceChildren(); },
    addClass(this: HTMLElement, ...names: string[]) { this.classList.add(...names); },
    removeClass(this: HTMLElement, ...names: string[]) { this.classList.remove(...names); },
    hasClass(this: HTMLElement, name: string) { return this.classList.contains(name); },
    toggleClass(this: HTMLElement, name: string, force: boolean) { this.classList.toggle(name, force); },
  });
});

/** Mounts the real toolbar, so zen rules are checked against the DOM the composer renders. */
function mountToolbar(toolbarEl: HTMLElement): void {
  const settings = { model: 'sonnet', reasoning: 'high', serviceTier: 'fast', permissionMode: 'normal' };
  createInputToolbar(toolbarEl, {
    onModelChange: async () => {}, onModeChange: async () => {},
    onEffortLevelChange: async () => {}, onServiceTierChange: async () => {}, onPermissionModeChange: async () => {},
    getSettings: () => settings,
    getUIConfig: () => ({
      getProviderIcon: () => null,
      getModelOptions: () => [{ value: 'sonnet', label: 'Sonnet' }, { value: 'opus', label: 'Opus' }],
      getReasoningOptions: () => [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }],
      getDefaultReasoningValue: () => 'low',
      getPermissionModeOptions: () => [{ value: 'normal', label: 'Safe' }, { value: 'yolo', label: 'YOLO', bypassesApprovals: true }],
      getServiceTierToggle: () => ({
        inactiveValue: 'default', inactiveLabel: 'Standard', activeValue: 'fast', activeLabel: 'Fast', isActive: true,
      }),
      getModeSelector: () => ({
        label: 'Mode', value: 'build',
        options: [{ value: 'build', label: 'Build' }, { value: 'plan', label: 'Plan' }],
      }),
    }),
    getCapabilities: () => ({ reasoningControl: 'effort' }),
  } as unknown as ToolbarCallbacks);
}

describe('Zen mode styles', () => {
  // jsdom applies rules in sheet order regardless of specificity; the utilities load last, as in index.css.
  const css = [
    'src/style/base/container.css',
    'src/style/components/input.css',
    'src/style/components/composer-editor.css',
    'src/style/components/context-tray.css',
    'src/style/components/context-footer.css',
    'src/style/components/composer-info-row.css',
    'src/style/toolbar/model-selector.css',
    'src/style/toolbar/thinking-selector.css',
    'src/style/components/side-chat.css',
    'src/style/components/zen-mode.css',
    'src/style/base/visibility.css',
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
            <div class="claudian-input-composer">
              <div class="claudian-input-container">
                <div class="claudian-input-nav-row"></div>
                <div class="claudian-input-wrapper">
                  <div class="claudian-input-queue-strip claudian-hidden"></div>
                  <div class="claudian-context-row"></div>
                  <div class="claudian-composer-editor">
                    <div class="cm-content"><div class="cm-line"><span class="cm-placeholder">Ask</span></div></div>
                  </div>
                  <div class="claudian-input-toolbar"></div>
                </div>
                <div class="claudian-input-info-row">
                  <div class="claudian-input-info-linked"></div>
                </div>
              </div>
            </div>
          </div>
          <div class="claudian-zen-side-chat-chip-slot claudian-side-chat-chip-slot">
            <div class="claudian-side-chat"><div class="claudian-side-chat-status">
              <button type="button" class="claudian-side-chat-status-toggle">Side chat</button>
            </div></div>
          </div>
          <button type="button" class="claudian-zen-grip" aria-label="Move chat panel"></button>
        </div>
      </div>
    `;
    mountToolbar(document.querySelector<HTMLElement>('.claudian-input-toolbar')!);
    return document.querySelector('.claudian-zen') as HTMLElement;
  }

  it('hides the whole drawer, open action included, while it is hidden', () => {
    const drawer = renderPanel().querySelector<HTMLElement>('.claudian-zen-drawer')!;
    expect(window.getComputedStyle(drawer).display).toBe('flex');

    drawer.classList.add('claudian-hidden');
    expect(window.getComputedStyle(drawer).display).toBe('none');
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
    expect(['', 'normal', '0']).toContain(window.getComputedStyle(panel).gap);
    expect(window.getComputedStyle(panel.querySelector('.claudian-zen-history')!).borderStyle).toBe('');
  });

  it('hides the info row, and keeps the context gauge beside the model control without its number', () => {
    const panel = renderPanel();
    expect(window.getComputedStyle(panel.querySelector('.claudian-input-info-row')!).display).toBe('none');

    const toolbar = panel.querySelector<HTMLElement>('.claudian-input-toolbar')!;
    const meter = toolbar.querySelector<HTMLElement>('.claudian-context-meter')!;
    expect(meter.previousElementSibling?.classList.contains('claudian-model-selector')).toBe(true);
    expect(window.getComputedStyle(meter).display).toBe('none');

    meter.classList.remove('claudian-hidden');
    expect(window.getComputedStyle(meter).display).toBe('flex');
    expect(window.getComputedStyle(meter.querySelector('.claudian-context-meter-gauge')!).display).toBe('flex');
    expect(window.getComputedStyle(meter.querySelector('.claudian-context-meter-percent')!).display).toBe('none');
  });

  it('caps the pill with the queued-message strip on its own row', () => {
    const composer = renderPanel().querySelector<HTMLElement>('.claudian-zen-composer')!;
    const strip = composer.querySelector<HTMLElement>('.claudian-input-queue-strip')!;
    strip.classList.replace('claudian-hidden', 'claudian-visible-flex');
    const style = window.getComputedStyle(strip);
    expect(style.display).toBe('flex');
    const wrapper = composer.querySelector<HTMLElement>('.claudian-input-wrapper')!;
    const inset = window.getComputedStyle(wrapper).getPropertyValue('padding-inline');
    expect(inset).not.toBe('');
    // jsdom retains var() expressions. Both offsets must derive from the wrapper's inset
    // so the strip stays edge to edge when that inset changes.
    expect({ basis: style.flexBasis, margin: style.getPropertyValue('margin-inline') })
      .toEqual({ basis: `calc(100% + 2 * ${inset})`, margin: `calc(-1 * ${inset})` });
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

  it('gives the expandable header no hover highlight', () => {
    renderPanel();
    const sheet = document.head.querySelector<HTMLStyleElement>('[data-testid="zen-styles"]')!.sheet!;
    const highlighted = Array.from(sheet.cssRules)
      .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
      .filter(rule => rule.selectorText.split(',').some(selector => /claudian-zen-disclosure:hover/.test(selector)))
      .filter(rule => /--background-modifier-hover/.test(rule.style.cssText));
    expect(highlighted.map(rule => rule.selectorText)).toEqual([]);
  });

  it('shows only the model control, with its effort and fast mode, beside the input', () => {
    const composer = renderPanel().querySelector<HTMLElement>('.claudian-zen-composer')!;
    const wrapper = window.getComputedStyle(composer.querySelector('.claudian-input-wrapper')!);
    expect({ direction: wrapper.flexDirection, wrap: wrapper.flexWrap }).toEqual({ direction: 'row', wrap: 'wrap' });
    const toolbarEl = composer.querySelector<HTMLElement>('.claudian-input-toolbar')!;
    const toolbar = within(toolbarEl);
    const isShown = (el: Element): boolean => {
      for (let node: Element | null = el; node && node !== composer; node = node.parentElement) {
        if (window.getComputedStyle(node).display === 'none') return false;
      }
      return true;
    };

    const model = toolbar.getByRole('button', { name: /^Model: Sonnet/, hidden: true });
    expect(isShown(model)).toBe(true);
    expect(isShown(model.querySelector('.claudian-thinking-current')!)).toBe(true);
    expect(isShown(model.querySelector('.claudian-service-tier-indicator')!)).toBe(true);
    // Permission and provider mode chips keep their values; zen only hides them.
    for (const name of [/^Permission mode: Safe/, /^Mode: Build/]) {
      expect([String(name), isShown(toolbar.getByRole('button', { name, hidden: true }))]).toEqual([String(name), false]);
    }
    expect(window.getComputedStyle(toolbarEl).flexWrap).toBe('nowrap');
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
    // Nothing attached: the input keeps the controls beside it.
    expect(style(editor).flexBasis).not.toBe('100%');

    row.createDiv({ cls: 'claudian-context-chip' }).dataset.contextSlot = 'images';
    row.classList.add('has-content');
    row.dataset.contextSlots = 'images';
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
    row.createDiv({ cls: 'claudian-context-chip' }).dataset.contextSlot = 'images';
    row.classList.add('has-content');
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

  it('opens control menus end-aligned inside the pill and keeps the placeholder on one line', () => {
    const composer = renderPanel().querySelector<HTMLElement>('.claudian-zen-composer')!;
    // The controls sit at the pill's end; a start-anchored menu would run past the pill's edge.
    // The model popover is placed against its own button, so its end is the button's end.
    fireEvent.click(within(composer).getByRole('button', { name: /^Model:/ }));
    const menu = window.getComputedStyle(within(composer).getByRole('dialog', { name: 'Model options' }));
    expect({ start: menu.getPropertyValue('inset-inline-start'), end: menu.getPropertyValue('inset-inline-end') })
      .toEqual({ start: 'auto', end: '0' });
    const placeholder = window.getComputedStyle(composer.querySelector('.cm-placeholder')!);
    // A truncated single-line hint needs a block box without a wrapping caret.
    expect(placeholder.display).toBe('inline-block');
    expect({ whiteSpace: placeholder.whiteSpace, textOverflow: placeholder.textOverflow })
      .toEqual({ whiteSpace: 'nowrap', textOverflow: 'ellipsis' });
  });

  it('hides the side chip slot when it becomes empty', () => {
    const slot = renderPanel().querySelector<HTMLElement>('.claudian-zen-side-chat-chip-slot')!;
    expect(window.getComputedStyle(slot).display).not.toBe('none');
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

  it('targets floating surfaces and controls while letting note clicks through layout wrappers', () => {
    const panel = renderPanel();
    const pointerEvents = (el: Element) => window.getComputedStyle(el).pointerEvents;
    expect(pointerEvents(panel)).toBe('none');
    for (const selector of [
      '.claudian-zen-composer',
      '.claudian-zen-side-chat-chip-slot',
      '.claudian-zen-side-chat-chip-slot .claudian-side-chat',
    ]) {
      expect([selector, pointerEvents(panel.querySelector(selector)!)]).toEqual([selector, 'none']);
    }
    for (const selector of [
      '.claudian-zen-drawer',
      '.claudian-zen-disclosure',
      '.claudian-input-composer',
      '.claudian-composer-editor',
      '.claudian-side-chat-status',
      '.claudian-zen-grip',
    ]) {
      expect([selector, pointerEvents(panel.querySelector(selector)!)]).toEqual([selector, 'auto']);
    }
    fireEvent.click(within(panel).getByRole('button', { name: /^Model:/ }));
    expect(pointerEvents(within(panel).getByRole('dialog', { name: 'Model options' }))).toBe('auto');
  });

  it('floats over the central workspace content without reserving a strip below it', () => {
    const panel = renderPanel();
    expect(window.getComputedStyle(panel.parentElement!).paddingBottom).toBe('');
    for (const selector of ['.cm-scroller', '.markdown-preview-view']) {
      expect(window.getComputedStyle(panel.parentElement!.querySelector(selector)!).paddingBottom).toBe('');
    }
  });

  it('subtracts status-bar clearance from the available panel height', () => {
    // jsdom cannot lay out the history, but this guards the TS/CSS property contract used to shrink it.
    expect(window.getComputedStyle(renderPanel()).maxHeight).toContain('var(--claudian-zen-bottom-clearance, 0px)');
  });

  // Notes render behind the floating surfaces, so translucent themes must not show through them.
  it('backs every floating surface with an opaque color', () => {
    const panel = renderPanel();
    for (const selector of [
      '.claudian-zen-drawer',
      '.claudian-zen-composer > .claudian-input-composer',
      '.claudian-zen-side-chat-chip-slot .claudian-side-chat-status',
    ]) {
      expect(window.getComputedStyle(panel.querySelector(selector)!).backgroundColor)
        .toBe('var(--background-secondary)');
    }
  });
});
