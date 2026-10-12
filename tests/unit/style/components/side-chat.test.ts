/** @jest-environment jsdom */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { fireEvent, within } from '@testing-library/dom';

import { SideChatPanel } from '@/features/chat/side-chat/SideChatPanel';

beforeAll(() => {
  Object.assign(HTMLElement.prototype, {
    setText(this: HTMLElement, text: string) { this.textContent = text; },
    toggleClass(this: HTMLElement, name: string, force: boolean) { this.classList.toggle(name, force); },
  });
});

describe('Side chat full height styles', () => {
  // jsdom applies rules in sheet order regardless of specificity; the utilities load last, as in index.css.
  const css = [
    'src/style/base/container.css',
    'src/style/components/tabs.css',
    'src/style/components/messages.css',
    'src/style/components/input.css',
    'src/style/components/side-chat.css',
    'src/style/components/zen-mode.css',
    'src/style/base/visibility.css',
  ]
    .map(file => readFileSync(path.resolve(file), 'utf8'))
    .join('\n');

  afterEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
  });

  /** Mounts a real panel in the view footer's composer slot, as the presentation placement does. */
  function renderView(composerParentSelector = '.claudian-active-input-slot') {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    document.body.innerHTML = `
      <div class="claudian-container">
        <div class="claudian-chat-panel">
          <div class="claudian-tab-content-container">
            <div class="claudian-tab-content"><div class="claudian-messages-wrapper"></div></div>
          </div>
          <div class="claudian-input-footer">
            <div class="claudian-side-chat-chip-slot"></div>
            <div class="claudian-input-nav-row claudian-view-input-nav-row"><div class="claudian-input-nav-content"></div></div>
            <div class="claudian-active-input-slot"></div>
          </div>
        </div>
        <div class="claudian-zen"><div class="claudian-zen-composer"></div></div>
      </div>
    `;
    const composerEl = document.querySelector(composerParentSelector)!
      .appendChild(document.createElement('div'));
    composerEl.className = 'claudian-input-composer claudian-side-chat-expanded';
    const panel = new SideChatPanel(composerEl, { onCollapse: () => {}, onDiscard: () => {}, onExpand: () => {} });
    // The view lends its chat panel only while the composer sits in its footer slot.
    if (composerParentSelector === '.claudian-active-input-slot') {
      panel.setFullHeightHost(document.querySelector<HTMLElement>('.claudian-chat-panel'));
    }
    return {
      panel,
      panelEl: panel.rootEl.querySelector<HTMLElement>('.claudian-side-chat-panel')!,
      transcriptEl: document.querySelector<HTMLElement>('.claudian-tab-content-container')!,
      navRowEl: document.querySelector<HTMLElement>('.claudian-view-input-nav-row')!,
      footerEl: document.querySelector<HTMLElement>('.claudian-input-footer')!,
    };
  }

  it('avoids :has, which forces broad selector invalidation', () => {
    expect(readFileSync(path.resolve('src/style/components/side-chat.css'), 'utf8')).not.toContain(':has(');
  });

  it('gives the main transcript space to the side panel while full height', () => {
    const { panel, panelEl, transcriptEl, navRowEl, footerEl } = renderView();
    expect(window.getComputedStyle(transcriptEl).display).toBe('flex');
    expect(window.getComputedStyle(panelEl).maxHeight).not.toBe('none');

    fireEvent.click(within(panel.rootEl).getByRole('button', { name: 'Full height' }));
    expect(window.getComputedStyle(transcriptEl).display).toBe('none');
    expect(window.getComputedStyle(navRowEl).display).not.toBe('none');
    expect(window.getComputedStyle(footerEl).flexGrow).toBe('1');
    expect(window.getComputedStyle(panelEl).maxHeight).toBe('none');

    fireEvent.click(within(panel.rootEl).getByRole('button', { name: 'Full height' }));
    expect(window.getComputedStyle(transcriptEl).display).toBe('flex');
    expect(window.getComputedStyle(panelEl).maxHeight).not.toBe('none');
  });

  it('restores the main transcript while collapsed and full height again on expansion', () => {
    const { panel, panelEl, transcriptEl } = renderView();
    panel.setCollapsedHost(document.querySelector<HTMLElement>('.claudian-side-chat-chip-slot'));
    fireEvent.click(within(panel.rootEl).getByRole('button', { name: 'Full height' }));
    panel.setExpanded(false);
    // The collapsed chip lives in the same footer as the composer.
    expect(panel.rootEl.closest('.claudian-input-footer')).not.toBeNull();
    expect(window.getComputedStyle(transcriptEl).display).toBe('flex');

    panel.setExpanded(true);
    expect(window.getComputedStyle(transcriptEl).display).toBe('none');
    expect(window.getComputedStyle(panelEl).maxHeight).toBe('none');
  });

  it('offers no full height control in the floating zen composer', () => {
    const { panel } = renderView('.claudian-zen-composer');
    const button = within(panel.rootEl).getByLabelText('Full height');
    expect(window.getComputedStyle(button).display).toBe('none');
    expect(window.getComputedStyle(within(panel.rootEl).getByRole('button', { name: 'Collapse' })).display)
      .not.toBe('none');
  });
});
