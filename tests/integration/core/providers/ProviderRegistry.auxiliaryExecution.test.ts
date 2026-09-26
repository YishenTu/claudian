import { FakeAuxiliaryBackend, waitFor } from '@test/helpers/core/auxiliary/AuxiliaryExecutionTestHarness';

import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ProviderRegistration } from '@/core/providers/types';

it.each([true, false])('selects auxiliary persistence from ephemeral support (%s)', async (supported) => {
  const backend = new FakeAuxiliaryBackend();
  const lifecycle = new ProviderExecutionLifecycleRegistry();
  ProviderRegistry.register('claude', {
    capabilities: { supportsEphemeralSessions: supported },
    createExecutionBackend: () => backend,
    displayName: 'Claude',
    isEnabled: () => true,
    chatUIConfig: { getModelOptions: () => [{ value: 'explicit-title-model', label: 'Title' }] },
  } as unknown as ProviderRegistration);
  const host = {
    settings: { titleGenerationModel: 'explicit-title-model' },
    app: { vault: { adapter: { basePath: '/vault' } } },
    executionLifecycleRegistry: lifecycle,
  } as unknown as ProviderHost;
  const title = ProviderRegistry.createTitleGenerationService(host, 'claude');
  const inlineEdit = ProviderRegistry.createInlineEditService(host, 'claude');
  try {
    const results = [
      title.generateTitle('conversation', 'Draft', jest.fn()),
      inlineEdit.editText({ instruction: 'Improve', mode: 'selection', notePath: 'note.md', selectedText: 'Draft' }),
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
    inlineEdit.cancel();
    await lifecycle.dispose();
  }
});
