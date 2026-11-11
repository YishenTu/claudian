/** @vitest-environment jsdom */

import { axe } from '@test/helpers/accessibility';
import { claudeCatalogFixture } from '@test/helpers/claudeModels';
import { createFeatureHostFixture } from '@test/helpers/FeatureHostFixture';
import { controlChangeSettled } from '@test/helpers/ObsidianHost';
import { createObsidianPlugin, mountSettingTab } from '@test/helpers/ObsidianSettingsHost';
import { fireEvent, within } from '@testing-library/dom';

import { registerProviderModules } from '@/core/providers/registerProviderModules';
import { ClaudianSettingTab } from '@/features/settings/ClaudianSettings';
import { t } from '@/i18n/i18n';
import { claudeProviderRegistration } from '@/providers/claude/registration';

registerProviderModules([claudeProviderRegistration]);
afterEach(() => document.body.replaceChildren());

const cases = [
  ['chatViewPlacement', 'settings.chatViewPlacement.name', 'right-sidebar', 'main-tab'],
  ['enableZenMode', 'settings.enableZenMode.name', true, false],
  ['enableDualPane', 'settings.enableDualPane.name', true, false],
  ['dualPaneSide', 'settings.dualPaneSide.name', 'right', 'left'],
  ['restoreTabsOnStartup', 'settings.restoreTabsOnStartup.name', true, false],
  ['enableAutoScroll', 'settings.enableAutoScroll.name', true, false],
  ['showMessageTimestamps', 'settings.showMessageTimestamps.name', false, true],
  ['deferMathRenderingDuringStreaming', 'settings.deferMathRenderingDuringStreaming.name', true, false],
  ['expandFileEditsByDefault', 'settings.expandFileEditsByDefault.name', false, true],
  ['enableAutoTitleGeneration', 'settings.autoTitle.name', true, false],
  ['titleGenerationModel', 'settings.titleModel.name', '', 'sonnet'],
  ['titleGenerationLocale', 'settings.titleLanguage.name', '', 'zh-CN'],
  ['sessionAutoArchiveAfter', 'settings.sessionAutoArchiveAfter.name', 'off', '7d'],
  ['requireCommandOrControlEnterToSend', 'settings.requireCommandOrControlEnterToSend.name', false, true],
] as const;

describe.each(['persist-failure', 'publish-failure', 'success'] as const)('%s', phase => {
  it.each(cases)('keeps the %s control aligned with committed settings', async (key, label, initial, next) => {
    const persist = vi.fn(async () => { if (phase === 'persist-failure') throw new Error('Storage unavailable'); });
    const fixture = await createFeatureHostFixture({
      settings: { [key]: initial, providerConfigs: { claude: { ...claudeCatalogFixture(['sonnet']) } } },
      beforePersist: persist,
      afterPublish: () => { if (phase === 'publish-failure') throw new Error('Publication unavailable'); },
    });
    await fixture.settingsStorage.save(fixture.settings);
    const container = document.body.createEl('main');
    const tab = new ClaudianSettingTab(fixture.host.app, createObsidianPlugin(fixture.host.app), fixture.host);
    const dispose = mountSettingTab(tab, container);
    onTestFinished(dispose);
    const role = typeof initial === 'boolean' ? 'switch' : 'combobox';
    const input = within(container).getByRole<HTMLInputElement | HTMLSelectElement>(role, { name: t(label) });
    if (typeof next === 'boolean') fireEvent.click(input);
    else fireEvent.change(input, { target: { value: next } });
    const error = await controlChangeSettled(input).then(() => '', (failure: Error) => failure.message);
    expect(error).toBe(phase === 'persist-failure' ? 'Storage unavailable'
      : phase === 'publish-failure' ? 'Settings were persisted, but post-commit publication failed.' : '');
    const committed = phase === 'persist-failure' ? initial : next;
    expect(fixture.settings[key]).toBe(committed);
    expect(persist).toHaveBeenCalledTimes(1);
    expect((await fixture.settingsStorage.load())[key]).toBe(committed);
    const current = within(container).getByRole<HTMLInputElement | HTMLSelectElement>(role, { name: t(label) });
    expect(typeof initial === 'boolean' ? (current as HTMLInputElement).checked : current.value).toBe(committed);
    expect(await axe(current.closest<HTMLElement>('.setting-item')!)).toHaveNoViolations();
  });
});
