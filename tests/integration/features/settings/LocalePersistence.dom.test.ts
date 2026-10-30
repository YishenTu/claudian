/** @vitest-environment jsdom */
import '@/providers';

import { deserialize, serialize } from 'node:v8';

import { axe } from '@test/helpers/accessibility';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@test/helpers/defaultSettings';
import { controlChangeSettled } from '@test/helpers/ObsidianSettingsDOM';
import { fireEvent, within } from '@testing-library/dom';

import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import { ClaudianSettingTab } from '@/features/settings/ClaudianSettings';
import { setLocale, t } from '@/i18n/i18n';

vi.mock('@/shared/settings/EnvironmentSettingsSection', () => ({ renderEnvironmentSettingsSection() {} }));
vi.mock('obsidian', async () => ({
  ...(await vi.importActual<typeof import('@test/__mocks__/obsidian')>('@test/__mocks__/obsidian')),
  ...(await vi.importActual<typeof import('@test/helpers/ObsidianSettingsDOM')>('@test/helpers/ObsidianSettingsDOM')),
}));

afterEach(() => { setLocale('en'); document.body.replaceChildren(); });

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
  const row = within(container).getByRole('combobox', { name: originalLabel }).closest<HTMLElement>('.setting-item')!;
  const input = within(row).getByRole('combobox') as HTMLSelectElement;
  fireEvent.change(input, { target: { value: 'zh-CN' } });
  const errorMessage = await controlChangeSettled(input).then(() => '', (error: Error) => error.message);
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
