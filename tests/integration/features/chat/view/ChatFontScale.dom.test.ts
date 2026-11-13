/** @vitest-environment jsdom */
import { claudeCatalogFixture } from '@test/helpers/claudeModels';
import { createFeatureHostFixture } from '@test/helpers/FeatureHostFixture';
import { controlChangeSettled } from '@test/helpers/ObsidianHost';
import { createObsidianPlugin, mountSettingTab } from '@test/helpers/ObsidianSettingsHost';
import { createObsidianWorkspace } from '@test/helpers/ObsidianWorkspace';
import { fireEvent, within } from '@testing-library/dom';
import type { Workspace } from 'obsidian';

import { registerProviderModules } from '@/core/providers/registerProviderModules';
import { ChatFontScale } from '@/features/chat/view/ChatFontScale';
import { ChatViewPublisher } from '@/features/chat/workspace/ChatViewPublisher';
import { ClaudianSettingTab } from '@/features/settings/ClaudianSettings';
import { t } from '@/i18n/i18n';
import { claudeProviderRegistration } from '@/providers/claude/registration';

registerProviderModules([claudeProviderRegistration]);
afterEach(() => {
  document.body.replaceChildren();
  document.body.removeAttribute('style');
});

const SCALE = '--claudian-font-scale';

it('scales chat text in every window from the committed slider value until unload', async () => {
  // A popout already open when the plugin loads, such as after a plugin update.
  const existingPopout = document.implementation.createHTMLDocument('existing popout');
  const leaves = [{ view: { containerEl: existingPopout.body.createDiv() } }];
  const workspace = Object.assign(createObsidianWorkspace(document.body.createDiv()), {
    iterateAllLeaves: (callback: (leaf: (typeof leaves)[number]) => void) => leaves.forEach(callback),
  });
  const publisher = new ChatViewPublisher({
    views: { getAllViews: () => [] },
    zenMode: { reconcile() {} },
    fontScale: { reconcile: () => fontScale.reconcile() },
    inactiveSessions: { request() {} },
    hasLoadedAllSessionMetadata: () => true,
  });
  const fixture = await createFeatureHostFixture({
    settings: { chatFontScale: 90, providerConfigs: { claude: { ...claudeCatalogFixture(['sonnet']) } } },
    afterPublish: (settings, previous) => publisher.publishSettings(settings, previous),
  });
  onTestFinished(() => fixture.dispose());
  const fontScale = new ChatFontScale({
    workspace: workspace as unknown as Workspace,
    getPercent: () => fixture.settings.chatFontScale,
  });
  fontScale.start();
  // A saved scale applies on load, before any settings edit.
  expect(document.body.style.getPropertyValue(SCALE)).toBe('0.9');
  expect(existingPopout.body.style.getPropertyValue(SCALE)).toBe('0.9');

  const container = document.body.createEl('main');
  const tab = new ClaudianSettingTab(fixture.host.app, createObsidianPlugin(fixture.host.app), fixture.host);
  onTestFinished(mountSettingTab(tab, container));
  const slider = within(container).getByRole<HTMLInputElement>('slider', { name: t('settings.chatFontScale.name') });
  expect(slider).toMatchObject({ min: '80', max: '120', step: '5', value: '90' });

  fireEvent.change(slider, { target: { value: '110' } });
  await controlChangeSettled(slider);
  expect(fixture.settings.chatFontScale).toBe(110);
  expect(document.body.style.getPropertyValue(SCALE)).toBe('1.1');
  expect(existingPopout.body.style.getPropertyValue(SCALE)).toBe('1.1');

  // Popout windows have their own body, which body-mounted chat surfaces inherit from.
  const popout = document.implementation.createHTMLDocument('popout');
  workspace.trigger('window-open', {}, { document: popout });
  expect(popout.body.style.getPropertyValue(SCALE)).toBe('1.1');

  fontScale.dispose();
  expect(document.body.style.getPropertyValue(SCALE)).toBe('');
  expect(popout.body.style.getPropertyValue(SCALE)).toBe('');
  expect(existingPopout.body.style.getPropertyValue(SCALE)).toBe('');
  expect(workspace.listenerCount()).toBe(0);
});
