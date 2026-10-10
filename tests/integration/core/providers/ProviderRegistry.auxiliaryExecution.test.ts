import { FakeAuxiliaryBackend, waitFor } from '@test/helpers/core/auxiliary/AuxiliaryExecutionTestHarness';

import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ProviderRegistration } from '@/core/providers/types';

it.each([true, false])('selects auxiliary persistence from ephemeral support (%s)', async (supported) => {
  const backend = new FakeAuxiliaryBackend();
  const lifecycle = new ProviderExecutionLifecycleRegistry();
  ProviderRegistry.register('claude', {
    capabilities: { supportsEphemeralSessions: supported },
    createExecutionBackend: () => backend,
    displayName: 'Claude',
    isEnabled: () => true,
    modelPolicy: { getModelOptions: () => [{ value: 'explicit-title-model', label: 'Title' }] },
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


beforeEach(() => {
  ProviderWorkspaceRegistry.clear();
  ProviderWorkspaceRegistry.setServices('claude', {} as never);
});
afterEach(() => ProviderWorkspaceRegistry.clear());

it('uses the selected title model and null reasoning, then returns provider text', async () => {
  const backend = new FakeAuxiliaryBackend();
  const lifecycle = new ProviderExecutionLifecycleRegistry();
  ProviderRegistry.register('claude', {
    capabilities: { supportsEphemeralSessions: true }, createExecutionBackend: () => backend,
    displayName: 'Claude', isEnabled: () => true,
    modelPolicy: { getModelOptions: () => [{ value: 'explicit-title-model', label: 'Title' }] },
  } as unknown as ProviderRegistration);
  const host = {
    settings: { titleGenerationModel: 'explicit-title-model' },
    app: { vault: { adapter: { basePath: '/vault' } } }, executionLifecycleRegistry: lifecycle,
  } as unknown as ProviderHost;
  const result = ProviderRegistry.runNamingTextTask(host, { prompt: 'Fix labels', systemPrompt: 'Name', timeoutMs: 1000 }, new AbortController().signal);
  try {
    await waitFor(() => backend.sessions[0]?.requests.length === 1);
    expect(backend.sessions[0].requests[0]).toMatchObject({
      configuration: { model: 'explicit-title-model', reasoning: null }, toolPolicy: { kind: 'passive' },
    });
    backend.sessions[0].emitText('Label repair');
    backend.sessions[0].complete();
    expect(await result).toBe('Label repair');
  } finally { await lifecycle.dispose(); }
});

it('cancels an in-flight naming task without changing a chat binding', async () => {
  const backend = new FakeAuxiliaryBackend();
  const lifecycle = new ProviderExecutionLifecycleRegistry();
  ProviderRegistry.register('claude', {
    capabilities: { supportsEphemeralSessions: true }, createExecutionBackend: () => backend,
    displayName: 'Claude', isEnabled: () => true,
    modelPolicy: { getModelOptions: () => [{ value: 'explicit-title-model', label: 'Title' }] },
  } as unknown as ProviderRegistration);
  const host = {
    settings: { titleGenerationModel: 'explicit-title-model' },
    app: { vault: { adapter: { basePath: '/vault' } } }, executionLifecycleRegistry: lifecycle,
  } as unknown as ProviderHost;
  const signal = new AbortController();
  const result = ProviderRegistry.runNamingTextTask(host, { prompt: 'Fix labels', systemPrompt: 'Name' }, signal.signal);
  const rejection = result.catch((error: unknown) => error);
  try {
    await waitFor(() => backend.sessions[0]?.requests.length === 1);
    signal.abort();
    expect(await rejection).toMatchObject({ message: 'Naming task cancelled.' });
    expect(backend.sessions[0].getStatus()).not.toBe('executing');
  } finally { await lifecycle.dispose(); }
});
