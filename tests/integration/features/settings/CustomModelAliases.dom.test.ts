/** @vitest-environment jsdom */
import { claudeCatalogFixture } from '@test/helpers/claudeModels';
import { createFeatureHostFixture } from '@test/helpers/FeatureHostFixture';
import { createObsidianPlugin, mountSettingTab } from '@test/helpers/ObsidianSettingsHost';
import { fireEvent, within } from '@testing-library/dom';

import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { registerProviderModules } from '@/core/providers/registerProviderModules';
import { ClaudianSettingTab } from '@/features/settings/ClaudianSettings';
import { t } from '@/i18n/i18n';
import { createClaudeWorkspaceServices } from '@/providers/claude/app/ClaudeWorkspaceServices';
import { claudeProviderRegistration } from '@/providers/claude/registration';

registerProviderModules([claudeProviderRegistration]);

afterEach(async () => {
  await ProviderWorkspaceRegistry.disposeInitialized();
  ProviderWorkspaceRegistry.register('claude', claudeProviderRegistration.workspace);
  document.body.replaceChildren();
});

it('renders no custom-model override editor for environment-declared Claude models', async () => {
  const fixture = await createFeatureHostFixture({
    settings: {
      settingsProvider: 'claude',
      providerConfigs: { claude: {
        enabled: true, ...claudeCatalogFixture(['sonnet']),
        environmentVariables: 'ANTHROPIC_MODEL=custom-model\nANTHROPIC_DEFAULT_SONNET_MODEL=custom-sonnet',
      } },
    },
  });
  const catalogProbe = vi.fn(async () => ({ models: [], outputStyles: [] }));
  ProviderWorkspaceRegistry.register('claude', {
    initialize: ({ plugin }) => createClaudeWorkspaceServices(plugin, { catalogProbe }),
  });
  const container = document.body.createEl('main');
  const tab = new ClaudianSettingTab(fixture.host.app, createObsidianPlugin(fixture.host.app), fixture.host);
  const dispose = mountSettingTab(tab, container);
  onTestFinished(async () => { dispose(); await fixture.dispose(); });

  fireEvent.click(within(container).getByRole('button', { name: t('settings.tabs.providers') }));
  const environment = await within(container).findByRole<HTMLTextAreaElement>(
    'textbox', { name: t('settings.customVariables.name') },
  );
  expect(environment.value).toBe('ANTHROPIC_MODEL=custom-model\nANTHROPIC_DEFAULT_SONNET_MODEL=custom-sonnet');
  const providerContent = environment.closest<HTMLElement>('.claudian-settings-provider-content')!;
  const overrides = () => within(providerContent).queryAllByRole('textbox', {
    name: /^(Alias|Context window) for custom-(model|sonnet)$/,
  });
  expect(overrides()).toEqual([]);
  expect(within(providerContent).queryByText('Custom model overrides')).toBeNull();

  // The query still addresses the retired controls if any were rendered.
  const injected = providerContent.createEl('input', {
    type: 'text', attr: { 'aria-label': 'Context window for custom-model' },
  });
  expect(overrides()).toEqual([injected]);
});
