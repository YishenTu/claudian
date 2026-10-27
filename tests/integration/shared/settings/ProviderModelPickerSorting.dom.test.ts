/** @jest-environment jsdom */

import '@test/helpers/ObsidianSettingsDOM';

import { deserialize, serialize } from 'node:v8';

import { firePointer } from '@test/helpers/dom/pointer';
import { fireEvent, waitFor, within } from '@testing-library/dom';

import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import { createProviderRuntimeHost } from '@/composition/ClaudianProviderHost';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { createCodexModels } from '@/providers/codex/runtime/CodexModels';
import { getCodexProviderSettings } from '@/providers/codex/settings';
import { renderProviderModelsSection } from '@/shared/settings/ProviderModelsSection';

jest.mock('obsidian', () => jest.requireActual('../../../helpers/ObsidianSettingsDOM'));

const ROW_HEIGHT = 50;
const ROW_GAP = 6;
const LIST_TOP = 100;

/** How far the settings pane around the picker is scrolled. */
let paneScroll = 0;

/**
 * jsdom has no layout. Selected model rows stack from the list top with a gap between them, and the list moves up as
 * the surrounding settings pane scrolls; transforms do not move layout.
 */
function installRowLayout(): () => void {
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains('claudian-provider-model-picker-selected-rows')) {
      return { top: LIST_TOP - paneScroll } as DOMRect;
    }
    if (!this.classList.contains('claudian-provider-model-picker-selected-row')) return original.call(this);
    const index = Array.from(this.parentElement!.children).indexOf(this);
    const top = LIST_TOP - paneScroll + index * (ROW_HEIGHT + ROW_GAP);
    return { top, bottom: top + ROW_HEIGHT, height: ROW_HEIGHT } as DOMRect;
  };
  return () => { HTMLElement.prototype.getBoundingClientRect = original; };
}

async function setup() {
  globalThis.structuredClone ??= value => deserialize(serialize(value));
  const model = (id: string, name: string) => ({
    model: id, displayName: name, description: '',
    supportedReasoningEfforts: [{ value: 'high', description: 'High' }], defaultReasoningEffort: 'high',
  });
  const settings = { providerConfigs: { codex: {
    enabled: true, visibleModels: ['alpha', 'beta', 'gamma'], modelAliases: {},
    discoveredModels: [model('alpha', 'Alpha'), model('beta', 'Beta'), model('gamma', 'Gamma')],
  } } };
  const coordinator = new SettingsCoordinator(settings, async () => {});
  const notify = jest.fn();
  const host = {
    settings, mutateSettings: coordinator.mutate.bind(coordinator), notifyProviderChatOptionsChanged: notify,
  } as unknown as ProviderHost;
  const catalog = createCodexModels(
    createProviderRuntimeHost(host, coordinator, 'codex'),
    { refresh: async () => ({ kind: 'skipped', models: [], refreshed: false }) },
  );
  await catalog.refresh();
  const container = document.body.createDiv();
  const picker = renderProviderModelsSection(container, 'codex', 'Codex', catalog);
  const row = (id: string) => container.querySelector<HTMLElement>(`[data-model-id="${id}"]`)!;
  const rowOrder = () => [...container.querySelectorAll('[data-model-id]')].map(el => el.getAttribute('data-model-id'));
  const press = (id: string, el: Element = row(id).querySelector('.claudian-provider-model-picker-selected-name')!) => {
    const startY = row(id).getBoundingClientRect().top + ROW_HEIGHT / 2;
    firePointer('pointerDown', el, startY);
    return startY;
  };
  const moveTo = (clientY: number) => firePointer('pointerMove', document, clientY);
  const release = (clientY: number) => firePointer('pointerUp', document, clientY);
  const visibleModels = () => getCodexProviderSettings(settings).visibleModels;
  return {
    container, moveTo, notify, picker, press, release, row, rowOrder, visibleModels,
    dispose: async () => { picker.dispose(); await catalog.dispose(); },
  };
}

let restoreLayout: () => void;
beforeEach(() => {
  paneScroll = 0;
  restoreLayout = installRowLayout();
});
afterEach(() => {
  restoreLayout();
  document.body.replaceChildren();
});

it('lifts a selected model and slides the others aside, saving its slot on release', async () => {
  const h = await setup();
  try {
    // Alpha sits at 100–150, Beta at 156–206, Gamma at 212–262.
    const startY = h.press('alpha');
    h.moveTo(startY + 2);
    expect(h.row('alpha').classList.contains('claudian-live-sort-lifted')).toBe(false);

    // Lowered 40px, Alpha's bottom (190) covers Beta past 30% but not Gamma; Beta moves up by a row and its gap.
    h.moveTo(startY + 40);
    expect(h.row('alpha').classList.contains('claudian-live-sort-lifted')).toBe(true);
    expect(h.row('alpha').style.transform).toBe('translateY(40px)');
    expect(h.row('beta').style.transform).toBe(`translateY(-${ROW_HEIGHT + ROW_GAP}px)`);
    expect(h.row('gamma').style.transform).toBe('');

    // A refresh while lifted waits, so the dragged row stays in place.
    const lifted = h.row('alpha');
    h.picker.refresh();
    expect(lifted.isConnected).toBe(true);

    h.release(startY + 40);
    await waitFor(() => expect(h.visibleModels()).toEqual(['beta', 'alpha', 'gamma']));
    await waitFor(() => expect(h.rowOrder()).toEqual(['beta', 'alpha', 'gamma']));
    expect(lifted.isConnected).toBe(false);
    expect(h.row('alpha').style.transform).toBe('');
  } finally {
    await h.dispose();
  }
});

it('moves a selected model to either end of the list', async () => {
  const h = await setup();
  try {
    h.press('gamma');
    h.moveTo(0);
    h.release(0);
    await waitFor(() => expect(h.visibleModels()).toEqual(['gamma', 'alpha', 'beta']));

    await waitFor(() => expect(h.rowOrder()).toEqual(['gamma', 'alpha', 'beta']));
    h.press('gamma');
    h.moveTo(1000);
    h.release(1000);
    await waitFor(() => expect(h.visibleModels()).toEqual(['alpha', 'beta', 'gamma']));
  } finally {
    await h.dispose();
  }
});

it('keeps a lifted model under the pointer while the settings pane scrolls', async () => {
  const h = await setup();
  try {
    const startY = h.press('alpha');
    h.moveTo(startY + 40);
    // The pane scrolls a row and its gap with the pointer held still; Alpha stays under it and now passes Gamma too.
    paneScroll = ROW_HEIGHT + ROW_GAP;
    fireEvent.scroll(h.container);
    expect(h.row('alpha').style.transform).toBe(`translateY(${40 + ROW_HEIGHT + ROW_GAP}px)`);
    expect(h.row('gamma').style.transform).toBe(`translateY(-${ROW_HEIGHT + ROW_GAP}px)`);

    h.release(startY + 40);
    await waitFor(() => expect(h.visibleModels()).toEqual(['beta', 'gamma', 'alpha']));
  } finally {
    await h.dispose();
  }
});

it('leaves the alias field and remove button to their own pointer behavior', async () => {
  const h = await setup();
  try {
    const rowView = within(h.row('beta'));
    for (const control of [
      rowView.getByRole('textbox', { name: 'Alias for Beta' }),
      rowView.getByRole('button', { name: /Remove/ }),
    ]) {
      const startY = h.press('beta', control);
      h.moveTo(startY + 60);
      expect(h.row('beta').classList.contains('claudian-live-sort-lifted')).toBe(false);
      h.release(startY + 60);
    }
    // The reorder handle still lifts the row.
    const startY = h.press('beta', rowView.getByRole('button', { name: /Reorder Beta/ }));
    h.moveTo(startY + 60);
    expect(h.row('beta').classList.contains('claudian-live-sort-lifted')).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(h.row('beta').classList.contains('claudian-live-sort-lifted')).toBe(false);
    expect(h.notify).not.toHaveBeenCalled();
  } finally {
    await h.dispose();
  }
});
