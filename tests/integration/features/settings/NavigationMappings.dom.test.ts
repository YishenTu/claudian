/** @vitest-environment jsdom */
import '@/providers';
import '@test/helpers/ObsidianSettingsDOM';

import { deserialize, serialize } from 'node:v8';

import { axe } from '@test/helpers/accessibility';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@test/helpers/defaultSettings';
import { fireEvent, within } from '@testing-library/dom';

import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import { ClaudianSettingTab } from '@/features/settings/ClaudianSettings';
import { buildNavMappingText } from '@/features/settings/keyboardNavigation';
import { t } from '@/i18n/i18n';

vi.mock('@/shared/settings/EnvironmentSettingsSection', () => ({ renderEnvironmentSettingsSection() {} }));
vi.mock('obsidian', async () => {
  const dom = (await vi.importActual<typeof import('@test/helpers/ObsidianSettingsDOM')>('@test/helpers/ObsidianSettingsDOM'));
  class Setting extends dom.Setting {
    setHeading() { return this; }
    addToggle(callback: (control: unknown) => void) {
      const toggleEl = this.settingEl.createEl('input', { attr: { type: 'checkbox' } });
      const toggle = {
        toggleEl,
        setValue(value: boolean) { toggleEl.checked = value; return this; },
        onChange(change: (value: boolean) => void) { toggleEl.addEventListener('change', () => change(toggleEl.checked)); return this; },
      };
      callback(toggle); return this;
    }
  }
  return { ...(await vi.importActual<typeof import('@test/__mocks__/obsidian')>('@test/__mocks__/obsidian')), ...dom, Setting };
});

it('keeps and then persists the newer navigation draft when an older save completes', async () => {
  globalThis.structuredClone ??= value => deserialize(serialize(value));
  vi.useFakeTimers();
  let usingFakeTimers = true;
  const settings = { ...structuredClone(DEFAULT_CLAUDIAN_SETTINGS), enableAutoTitleGeneration: false };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const saved: string[] = [];
  const coordinator = new SettingsCoordinator(settings, async draft => {
    saved.push(buildNavMappingText(draft.keyboardNavigation));
    if (saved.length === 1) await gate;
  });
  const host = { settings, mutateSettings: coordinator.mutate.bind(coordinator) };
  const tab = new ClaudianSettingTab({} as never, {} as never, host as never);
  const container = document.body.createDiv();
  try {
    tab['renderGeneralTab'](container);
    const row = within(container).getByText(t('settings.navMappings.name')).parentElement!;
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
