import { createProviderHostFixture, type ProviderHostFixtureOptions } from '@test/helpers/providerRuntimeHost';

import { AgentSkillResources } from '@/composition/AgentSkillResources';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { FeatureHost } from '@/features/FeatureHost';

export interface FeatureHostFixtureOptions extends Omit<ProviderHostFixtureOptions, 'overrides'> {
  providerOverrides?: ProviderHostFixtureOptions['overrides'];
  overrides?: Partial<FeatureHost>;
}

/** Feature-neutral host; chat fixtures add their capabilities over this same set of owners. */
export async function createFeatureHostFixture({ providerOverrides, overrides, ...options }: FeatureHostFixtureOptions = {}) {
  const fixture = await createProviderHostFixture({ ...options, overrides: providerOverrides });
  const providerHost = fixture.host;
  const agentSkills = new AgentSkillResources(() => []);
  const host: FeatureHost = {
    app: providerHost.app, providerHost, settings: fixture.settings, storage: fixture.storage,
    getCommittedSettings: fixture.coordinator.getCommittedSettings.bind(fixture.coordinator),
    mutateSettings: fixture.coordinator.mutate.bind(fixture.coordinator),
    getActiveEnvironmentVariables: id => providerHost.getActiveEnvironmentVariables(id ?? ProviderRegistry.resolveSettingsProviderId(fixture.settings)),
    getAgentSkillResourceGeneration: () => agentSkills.getGeneration(),
    notifyAgentSkillsChanged: () => agentSkills.notifyChanged(),
    notifyProviderChatOptionsChanged: id => providerHost.notifyProviderChatOptionsChanged(id),
    getActiveModelSelection: () => null,
    ...overrides,
  };
  return { ...fixture, host, providerHost, agentSkills };
}
