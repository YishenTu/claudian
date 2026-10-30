import { TEST_CODEX_CATALOG, TEST_CODEX_MODEL } from '@test/helpers/codexModels';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';

import type { ProviderCLIResolutionContext, ProviderId } from '@/core/providers/types';
import type { ClaudianSettings } from '@/core/types';
import { createCodexWorkspaceServices } from '@/providers/codex/app/CodexWorkspaceServices';

/** Codex workspace services over the shared host's real persistence and lifecycle owners. */
export async function createCodexWorkspaceHarness(config: Record<string, unknown> = {}) {
  const saves: ClaudianSettings[] = [];
  const resolveCliPath = vi.fn(async (_id: ProviderId, _context?: ProviderCLIResolutionContext): Promise<string | null> => null);
  const fixture = await createProviderHostFixture({
    settings: {
      settingsProvider: 'codex', model: TEST_CODEX_MODEL, effortLevel: 'high', serviceTier: 'default',
      titleGenerationModel: '', permissionMode: 'normal', envSnippets: [],
      providerConfigs: { codex: { enabled: true, discoveredModels: TEST_CODEX_CATALOG, ...config }, claude: { enabled: true } },
    },
    beforePersist: draft => { saves.push(structuredClone(draft)); },
    overrides: { getResolvedProviderCliPath: resolveCliPath },
  });
  const services = await createCodexWorkspaceServices(fixture.host);
  return {
    ...fixture, plugin: fixture.host, registry: fixture.lifecycle, services, saves, resolveCliPath,
    async dispose() {
      try {
        await fixture.lifecycle.dispose();
        await services.dispose();
      } finally { await fixture.dispose(); }
    },
  };
}
