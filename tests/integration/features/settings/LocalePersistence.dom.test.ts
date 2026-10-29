/** @vitest-environment jsdom */
import '@/providers';
import '@test/helpers/ObsidianSettingsDOM';

import { deserialize, serialize } from 'node:v8';

import { axe } from '@test/helpers/accessibility';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@test/helpers/defaultSettings';
import { fireEvent, waitFor, within } from '@testing-library/dom';

import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import { ClaudianSettingTab } from '@/features/settings/ClaudianSettings';
import { setLocale, t } from '@/i18n/i18n';

const mockChanges: Promise<void>[] = [];

vi.mock('@/shared/settings/EnvironmentSettingsSection', () => ({ renderEnvironmentSettingsSection() {} }));
vi.mock('obsidian', async () => {
  const dom = (await vi.importActual<typeof import('@test/helpers/ObsidianSettingsDOM')>('@test/helpers/ObsidianSettingsDOM'));
  class Setting extends dom.Setting {
    setHeading() { return this; }
    addToggle(callback: (control: any) => void) {
      const toggleEl = this.settingEl.createEl('input', { attr: { type: 'checkbox' } });
      const toggle = {
        toggleEl,
        setValue(value: boolean) { toggleEl.checked = value; return this; },
        onChange(change: (value: boolean) => void) { toggleEl.addEventListener('change', () => change(toggleEl.checked)); return this; },
      };
      callback(toggle); return this;
    }
    addDropdown(callback: (control: any) => void) {
      const selectEl = this.settingEl.createEl('select');
      const control = {
        selectEl,
        addOption(value: string, label: string) { selectEl.add(new Option(label, value)); return this; },
        setValue(value: string) { selectEl.value = value; return this; },
        onChange(change: (value: string) => Promise<void>) {
          selectEl.addEventListener('change', () => {
            const pending = Promise.resolve(change(selectEl.value));
            // The external control adapter records rejections rather than leaking them to the test runner.
            void pending.catch(() => undefined);
            mockChanges.push(pending);
          });
          return this;
        },
      };
      callback(control); return this;
    }
  }
  return { ...(await vi.importActual<typeof import('@test/__mocks__/obsidian')>('@test/__mocks__/obsidian')), ...dom, Setting };
});

afterEach(() => { setLocale('en'); document.body.replaceChildren(); mockChanges.length = 0; });

it.each(['persist-failure', 'publish-failure', 'success'])('keeps the translator and control aligned with committed settings after %s', async phase => {
  globalThis.structuredClone ??= value => deserialize(serialize(value));
  setLocale('en');
  const originalLabel = t('settings.language.name');
  setLocale('zh-CN');
  const translatedLabel = t('settings.language.name');
  setLocale('en');
  expect(translatedLabel).not.toBe(originalLabel);
  const settings = { ...structuredClone(DEFAULT_CLAUDIAN_SETTINGS), locale: 'en', enableAutoTitleGeneration: false };
  let saved = JSON.stringify(settings);
  const coordinator = new SettingsCoordinator(settings, async draft => {
    if (phase === 'persist-failure') throw new Error('Storage unavailable');
    saved = JSON.stringify(draft);
  }, async () => {
    if (phase === 'publish-failure') throw new Error('Publication unavailable');
  });
  const host = { settings, mutateSettings: coordinator.mutate.bind(coordinator) };
  const tab = new ClaudianSettingTab({} as never, {} as never, host as never);
  const container = document.body.createDiv();
  tab['renderGeneralTab'](container);
  const row = within(container).getByText(originalLabel).parentElement!;
  const input = within(row).getByRole('combobox') as HTMLSelectElement;
  fireEvent.change(input, { target: { value: 'zh-CN' } });
  await waitFor(() => expect(mockChanges).toHaveLength(1));
  const errorMessage = await mockChanges[0].then(() => '', (error: Error) => error.message);
  expect(errorMessage).toBe(phase === 'persist-failure' ? 'Storage unavailable'
    : phase === 'publish-failure' ? 'Settings were persisted, but post-commit publication failed.' : '');
  const committedLocale = phase === 'persist-failure' ? 'en' : 'zh-CN';
  expect(settings.locale).toBe(committedLocale);
  expect(JSON.parse(saved).locale).toBe(committedLocale);
  expect({ control: input.value, translation: t('settings.language.name') }).toEqual({
    control: committedLocale,
    translation: committedLocale === 'en' ? originalLabel : translatedLabel,
  });
  expect((await axe(row, { runOnly: ['aria-valid-attr', 'aria-valid-attr-value'] })).violations).toEqual([]);
});
