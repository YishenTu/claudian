/** @vitest-environment jsdom */
import '@/providers';

import { deserialize, serialize } from 'node:v8';

import { axe } from '@test/helpers/accessibility';
import { createFeatureHostFixture } from '@test/helpers/FeatureHostFixture';
import { createObsidianPlugin } from '@test/helpers/ObsidianSettingsHost';
import { fireEvent, within } from '@testing-library/dom';

import { ClaudianSettingTab } from '@/features/settings/ClaudianSettings';
import { buildNavMappingText } from '@/features/settings/keyboardNavigation';
import { t } from '@/i18n/i18n';

it('keeps and then persists the newer navigation draft when an older save completes', async () => {
  globalThis.structuredClone ??= value => deserialize(serialize(value));
  vi.useFakeTimers();
  let usingFakeTimers = true;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const saved: string[] = [];
  const { settings, coordinator, host } = await createFeatureHostFixture({
    settings: { enableAutoTitleGeneration: false },
    beforePersist: async draft => {
      saved.push(buildNavMappingText(draft.keyboardNavigation));
      if (saved.length === 1) await gate;
    },
  });
  const tab = new ClaudianSettingTab(host.app, createObsidianPlugin(host.app), host);
  const container = document.body.createDiv();
  try {
    tab['renderGeneralTab'](container);
    const row = within(container).getByRole('textbox', { name: t('settings.navMappings.name') }).closest<HTMLElement>('.setting-item')!;
    const input = within(row).getByRole('textbox') as HTMLTextAreaElement;
    const first = 'map k scrollUp\nmap j scrollDown\nmap f focusInput';
    const latest = 'map u scrollUp\nmap d scrollDown\nmap e focusInput';
    fireEvent.input(input, { target: { value: first } });
    await vi.advanceTimersByTimeAsync(500);
    expect(saved).toEqual([first]);
    fireEvent.input(input, { target: { value: latest } });
    release();
    await coordinator.persistCurrent();
    expect(input.value).toBe(latest);
    await vi.advanceTimersByTimeAsync(500);
    await coordinator.persistCurrent();
    expect(buildNavMappingText(settings.keyboardNavigation)).toBe(latest);
    expect(saved).toContain(latest);
    fireEvent.blur(input);
    await coordinator.persistCurrent();
    expect(input.value).toBe(latest);
    vi.useRealTimers();
    usingFakeTimers = false;
    expect((await axe(row, { runOnly: ['aria-valid-attr', 'aria-valid-attr-value'] })).violations).toEqual([]);
  } finally {
    release();
    if (usingFakeTimers) { vi.clearAllTimers(); vi.useRealTimers(); }
    container.remove();
  }
});
