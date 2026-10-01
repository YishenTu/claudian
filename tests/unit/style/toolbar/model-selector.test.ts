/** @jest-environment jsdom */

import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('Toolbar popover styles', () => {
  const css = ['src/style/base/variables.css', 'src/style/toolbar/model-selector.css', 'src/style/toolbar/thinking-selector.css', 'src/style/toolbar/permission-toggle.css', 'src/style/toolbar/service-tier-toggle.css']
    .map(file => readFileSync(path.resolve(file), 'utf8'))
    .join('\n');

  afterEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
  });

  function renderToolbar(): HTMLElement {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    document.body.innerHTML = `
      <div class="claudian-input-toolbar">
        <div class="claudian-toolbar-chip-anchor claudian-toolbar-chip-anchor--model">
          <button type="button" class="claudian-toolbar-chip claudian-model-btn">
            <span class="claudian-toolbar-chip-primary claudian-model-label">Sonnet</span>
            <span class="claudian-toolbar-chip-secondary claudian-thinking-current">High</span>
            <span class="claudian-toolbar-chip-secondary claudian-service-tier-indicator"></span>
            <span class="claudian-toolbar-chip-chevron"></span>
          </button>
          <div class="claudian-toolbar-popover" data-popover="model">
            <button type="button" role="option" aria-selected="true" class="claudian-toolbar-popover-option claudian-model-option">
              <svg class="claudian-provider-icon claudian-model-provider-icon"></svg>
              <span class="claudian-toolbar-popover-option-label">Sonnet</span>
              <span class="claudian-toolbar-popover-option-check"></span>
            </button>
            <button type="button" role="option" aria-selected="false" class="claudian-toolbar-popover-option claudian-model-option">
              <svg class="claudian-provider-icon claudian-model-provider-icon"></svg>
              <span class="claudian-toolbar-popover-option-label">Opus</span>
            </button>
            <div class="claudian-toolbar-slider-group"><span class="claudian-toolbar-slider-value">High</span></div>
            <button type="button" role="switch" aria-checked="true" class="claudian-toolbar-popover-option claudian-toolbar-popover-switch-row">
              <span class="claudian-toggle-switch active"></span>
            </button>
          </div>
        </div>
        <div class="claudian-toolbar-chip-anchor claudian-permission-toggle">
          <button type="button" class="claudian-toolbar-chip claudian-toolbar-chip--alert">
            <span class="claudian-toolbar-chip-icon" data-part="permission-icon"></span>
            <span class="claudian-toolbar-chip-primary claudian-permission-label">YOLO</span>
            <span class="claudian-toolbar-chip-chevron"></span>
          </button>
          <div class="claudian-toolbar-popover" data-popover="permission"></div>
        </div>
      </div>
    `;
    return document.querySelector('.claudian-input-toolbar') as HTMLElement;
  }

  const style = (el: Element) => window.getComputedStyle(el);

  it('sizes the model popover from its button and its content instead of a fixed width', () => {
    const toolbar = renderToolbar();
    const anchor = toolbar.querySelector('.claudian-toolbar-chip-anchor--model')!;
    const popover = style(toolbar.querySelector('[data-popover="model"]')!);
    // The button is the containing block, so the popover starts at its edge and is at least as wide.
    expect(style(anchor).position).toBe('relative');
    expect({ start: popover.getPropertyValue('inset-inline-start'), width: popover.width })
      .toEqual({ start: '0', width: 'max-content' });
    expect(popover.minWidth).toContain('100%');
  });

  it('gives the model and permission chips no fill on hover, focus or while open', () => {
    const toolbar = renderToolbar();
    const rules = Array.from(document.head.querySelector('style')!.sheet!.cssRules)
      .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
      .filter(rule => rule.selectorText.includes('button.claudian-toolbar-chip')
        && /:hover|aria-expanded/.test(rule.selectorText)
        && !rule.selectorText.includes('--accent'));
    expect(rules.map(rule => rule.style.getPropertyValue('background')).filter(value => value && value !== 'transparent'))
      .toEqual([]);
    const button = toolbar.querySelector<HTMLElement>('button.claudian-model-btn')!;
    button.setAttribute('aria-expanded', 'true');
    expect(style(button).background).not.toContain('modifier-hover');
  });

  it('draws the menus with a border only, no shadow spilling past it', () => {
    const toolbar = renderToolbar();
    for (const popover of Array.from(toolbar.querySelectorAll('.claudian-toolbar-popover'))) {
      expect(['', 'none']).toContain(style(popover).boxShadow);
    }
  });

  it('flips each chip chevron to point up while its menu is open', () => {
    const toolbar = renderToolbar();
    for (const button of Array.from(toolbar.querySelectorAll<HTMLElement>('button.claudian-toolbar-chip'))) {
      const chevron = button.querySelector('.claudian-toolbar-chip-chevron')!;
      expect(['', 'none']).toContain(style(chevron).transform);
      button.setAttribute('aria-expanded', 'true');
      expect(style(chevron).transform).toBe('rotate(180deg)');
      button.setAttribute('aria-expanded', 'false');
      expect(['', 'none']).toContain(style(chevron).transform);
    }
  });

  it('sizes the permission menu from its own button the same way, without the slider floor, opening from its end edge', () => {
    const toolbar = renderToolbar();
    const popover = style(toolbar.querySelector('[data-popover="permission"]')!);
    expect(style(toolbar.querySelector('.claudian-permission-toggle')!).position).toBe('relative');
    expect({
      start: popover.getPropertyValue('inset-inline-start'),
      end: popover.getPropertyValue('inset-inline-end'),
      width: popover.width,
      minWidth: popover.minWidth,
    }).toEqual({ start: 'auto', end: '0', width: 'max-content', minWidth: '100%' });
  });

  it.each([
    ['the toolbar buttons', /button\.claudian-toolbar-chip$/],
    // The popover's own label would otherwise pop up over every control inside it, such as the slider.
    ['the popovers and everything inside them', /^\.claudian-toolbar-popover$/],
  ])('suppresses Obsidian hover tooltips on %s', (_name, pattern) => {
    renderToolbar();
    // Obsidian skips aria-label tooltips when the hovered element computes --no-tooltip to "true";
    // jsdom does not compute custom properties, so check the declaration on the rule.
    const sheet = document.head.querySelector('style')!.sheet!;
    const declared = Array.from(sheet.cssRules)
      .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
      .filter(rule => rule.selectorText.split(',').some(selector => pattern.test(selector.trim())))
      .map(rule => rule.style.getPropertyValue('--no-tooltip').trim())
      .filter(Boolean);
    expect(declared).toEqual(['true']);
  });

  it('shows every provider icon in the list in its brand colour and marks the selection with a light green tick only', () => {
    const toolbar = renderToolbar();
    const color = (selector: string) => style(toolbar.querySelector(selector)!).color;
    const brand = 'var(--claudian-brand)';
    // Only the icon is tinted; model names read as normal text.
    expect({
      selectedIcon: color('[aria-selected="true"] .claudian-model-provider-icon'),
      selectedLabel: color('[aria-selected="true"] .claudian-toolbar-popover-option-label'),
      otherIcon: color('[aria-selected="false"] .claudian-model-provider-icon'),
      otherLabel: color('[aria-selected="false"] .claudian-toolbar-popover-option-label'),
    }).toEqual({ selectedIcon: brand, selectedLabel: 'var(--text-normal)', otherIcon: brand, otherLabel: 'var(--text-normal)' });

    // The selected row gets no fill; only its tick marks the choice.
    const selected = style(toolbar.querySelector('[aria-selected="true"]')!);
    expect(`${selected.background} ${selected.backgroundColor}`).not.toMatch(/modifier-hover|claudian-brand/);
    expect(color('.claudian-toolbar-popover-option-check')).toBe('var(--claudian-selection-check)');
    expect({
      buttonModel: color('.claudian-model-label'),
      buttonReasoning: color('.claudian-thinking-current'),
      buttonFastMode: color('.claudian-service-tier-indicator'),
      level: color('.claudian-toolbar-slider-value'),
      permission: color('.claudian-permission-label'),
    }).toEqual({
      buttonModel: 'var(--text-normal)',
      buttonReasoning: 'var(--text-muted)',
      // The zap only shows while fast mode is on, so it reads as an active state, not a muted detail.
      buttonFastMode: 'var(--text-normal)',
      level: 'var(--text-normal)',
      permission: 'var(--text-normal)',
    });

    // Hover, focus and an open menu brighten the chip itself, but the reasoning level stays a muted detail.
    toolbar.querySelector('button.claudian-model-btn')!.setAttribute('aria-expanded', 'true');
    expect({
      buttonReasoning: color('.claudian-thinking-current'),
      buttonFastMode: color('.claudian-service-tier-indicator'),
    }).toEqual({ buttonReasoning: 'var(--text-muted)', buttonFastMode: 'var(--text-normal)' });
  });

  it.each(['claude', 'codex', 'opencode', 'pi', 'grok'])(
    'gives a %s model row its own brand colour for its icon when providers share one list',
    (provider) => {
      renderToolbar();
      // jsdom does not compute custom properties, so check the alias declared for the row.
      const sheet = document.head.querySelector('style')!.sheet!;
      const aliases = Array.from(sheet.cssRules)
        .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
        .filter(rule => rule.selectorText.split(',')
          .some(selector => selector.trim().endsWith(`.claudian-model-option[data-provider="${provider}"]`)))
        .map(rule => rule.style.getPropertyValue('--claudian-brand').trim());
      expect(aliases).toEqual([`var(--claudian-brand-${provider})`]);
    },
  );

  it('warns about the unrestricted permission mode through its icon only', () => {
    const toolbar = renderToolbar();
    const color = (selector: string) => style(toolbar.querySelector(selector)!).color;
    // The warning shield is Claude orange under every provider; the label reads like any other chip.
    expect({
      icon: color('[data-part="permission-icon"]'),
      label: color('.claudian-permission-label'),
      button: color('.claudian-toolbar-chip--alert'),
    }).toEqual({
      icon: 'var(--claudian-brand-claude)',
      label: 'var(--text-normal)',
      button: 'var(--text-muted)',
    });
  });

  it('shows fast mode on with neutral colours, not the provider brand', () => {
    const toolbar = renderToolbar();
    const track = style(toolbar.querySelector('.claudian-toggle-switch.active')!);
    // jsdom does not style pseudo-elements, so read the knob's declaration from its rule.
    const sheet = document.head.querySelector('style')!.sheet!;
    const knob = Array.from(sheet.cssRules)
      .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
      .find(rule => rule.selectorText === '.claudian-toggle-switch.active::after')!;
    const surfaces = [track.background, track.backgroundColor, knob.style.background, knob.style.backgroundColor];
    expect(surfaces.join(' ')).not.toContain('claudian-brand');
    expect(knob.style.background || knob.style.backgroundColor).toBe('var(--text-normal)');
  });
});
