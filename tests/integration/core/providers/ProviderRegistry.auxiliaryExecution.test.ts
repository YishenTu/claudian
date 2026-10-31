import { FakeAuxiliaryBackend, waitFor } from '@test/helpers/core/auxiliary/AuxiliaryExecutionTestHarness';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { claudeProviderRegistration } from '@/providers/claude/registration';

it.each([true, false])('selects auxiliary persistence from ephemeral support (%s)', async (supported) => {
  const backend = new FakeAuxiliaryBackend();
  ProviderRegistry.register('claude', {
    ...claudeProviderRegistration,
    capabilities: { ...claudeProviderRegistration.capabilities, supportsEphemeralSessions: supported },
    createExecutionBackend: () => backend,
    displayName: 'Claude',
    isEnabled: () => true,
    modelPolicy: { ...claudeProviderRegistration.modelPolicy, getModelOptions: () => [{ value: 'explicit-title-model', label: 'Title' }] },
  });
  const { host, lifecycle } = await createProviderHostFixture({ settings: { titleGenerationModel: 'explicit-title-model' } });
  ProviderWorkspaceRegistry.setServices('claude', {});
  const title = ProviderRegistry.createTitleGenerationService(host);
  const inlineEdit = ProviderRegistry.createInlineEditService(host, 'claude');
  try {
    const results = [
      title.generateTitle('conversation', 'Draft', vi.fn()),
      inlineEdit.send({ instruction: 'Improve', mode: 'selection', notePath: 'note.md', selectedText: 'Draft' }),
    ];
    await waitFor(() => backend.sessions.length === 2 && backend.sessions.every(session => session.requests.length === 1));
    const configs = [...backend.configs];
    for (const session of backend.sessions) {
      session.emitText('Which tone?');
      session.complete();
    }
    await Promise.all(results);
    expect(configs).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({
      lifecycle: 'ephemeral',
      nativePersistence: supported ? 'disabled-if-supported' : 'provider-default',
    })));
  } finally {
    title.cancel();
    inlineEdit.end();
    await lifecycle.dispose();
    ProviderWorkspaceRegistry.clear();
  }
});
