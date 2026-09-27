import { ProviderModelCatalogController, type ProviderModelSelectionChange } from '@/core/providers/models/ProviderModelCatalog';

function fixture() {
  let models = [{ id: 'selected', name: 'Selected' }];
  const discover = jest.fn(async () => ({ changed: true }));
  const catalog = new ProviderModelCatalogController({
    providerId: 'example', providerName: 'Example',
    read: () => ({ enabled: true, models, selectedIds: ['selected', 'missing'], aliases: {} }),
    discover, update: jest.fn(),
    host: { mutateSettings: async mutate => { await mutate({} as any); }, notifyProviderChatOptionsChanged: jest.fn() },
  });
  return { catalog, discover, replace: (next: typeof models) => { models = next; } };
}

it('loads the full catalog once even with restored selected metadata and reuses it until forced', async () => {
  const { catalog, discover } = fixture();
  expect(discover).not.toHaveBeenCalled();
  await catalog.refresh();
  await catalog.refresh();
  expect(discover).toHaveBeenCalledTimes(1);
  await catalog.refresh({ force: true });
  expect(discover).toHaveBeenCalledTimes(2);
});

it('retains stale rows without automatic discovery and preserves missing selections as unavailable', async () => {
  const { catalog, discover } = fixture();
  await catalog.refresh();
  catalog.markStale();
  await catalog.refresh();
  expect(discover).toHaveBeenCalledTimes(1);
  expect(catalog.getSnapshot()).toMatchObject({ stale: true, selectedIds: ['selected', 'missing'], defaultModelId: 'selected' });
  expect(catalog.getSnapshot().models).toContainEqual(expect.objectContaining({ id: 'missing', isAvailable: false }));
  await catalog.refresh({ force: true });
  expect(catalog.getSnapshot().stale).toBe(false);
});

it('keeps cached rows when discovery fails and clears the error on an explicit retry', async () => {
  const { catalog, discover } = fixture();
  await catalog.refresh();
  discover.mockRejectedValueOnce(new Error('Offline'));
  await catalog.refresh({ force: true });
  expect(catalog.getSnapshot()).toMatchObject({ status: 'failed', models: expect.arrayContaining([expect.objectContaining({ id: 'selected' })]) });
  await catalog.refresh({ force: true });
  expect(catalog.getSnapshot().status).toBe('ready');
});

it('does not mark superseded discovery fresh', async () => {
  const { catalog, discover } = fixture();
  let finish!: () => void;
  discover.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ changed: true }); }));
  const refresh = catalog.refresh();
  catalog.markStale();
  finish();
  await refresh;
  expect(catalog.getSnapshot().stale).toBe(true);
});

it('waits for the configuration transition before admitting new discovery', async () => {
  const { catalog, discover } = fixture();
  catalog.beginTransition();
  const pending = catalog.refresh({ force: true });
  await Promise.resolve();
  expect(discover).not.toHaveBeenCalled();
  catalog.endTransition();
  await pending;
  expect(discover).toHaveBeenCalledTimes(1);
  expect(catalog.getSnapshot()).toMatchObject({ status: 'ready', stale: false });
});

it('settles queued discovery without starting it when disposed during a transition', async () => {
  const { catalog, discover } = fixture();
  catalog.beginTransition();
  const pending = catalog.refresh();
  await catalog.dispose();
  await expect(pending).resolves.toEqual({ changed: false });
  expect(discover).not.toHaveBeenCalled();
});

it('starts a new forced discovery after abort and drains the old request on disposal', async () => {
  const { catalog, discover } = fixture();
  let releaseOld!: () => void;
  discover.mockImplementationOnce(() => new Promise(resolve => {
    releaseOld = () => resolve({ changed: true });
  }));
  const old = catalog.refresh();
  catalog.markStale();
  const replacement = catalog.refresh({ force: true });
  expect(discover).toHaveBeenCalledTimes(2);
  await replacement;
  expect(catalog.getSnapshot()).toMatchObject({ stale: false, status: 'ready' });
  let disposed = false;
  const disposal = catalog.dispose().then(() => { disposed = true; });
  await Promise.resolve();
  expect(disposed).toBe(false);
  releaseOld();
  await Promise.all([old, disposal]);
  expect(disposed).toBe(true);
});

it('notifies only for committed selection and alias writes, not discovery or status', async () => {
  const notify = jest.fn();
  const catalog = new ProviderModelCatalogController({
    providerId: 'example', providerName: 'Example',
    read: () => ({ enabled: true, models: [], selectedIds: [], aliases: {} }),
    discover: async () => ({ changed: true }),
    update: jest.fn(),
    host: { mutateSettings: async mutate => { await mutate({} as any); }, notifyProviderChatOptionsChanged: notify },
  });
  await catalog.refresh();
  catalog.markStale();
  expect(notify).not.toHaveBeenCalled();
  await catalog.changeSelection({ type: 'set', modelId: 'selected', selected: true });
  expect(notify).toHaveBeenCalledTimes(1);
  await catalog.setAlias('selected', 'Alias');
  expect(notify).toHaveBeenCalledTimes(2);
});

it('unsubscribes a settings observer without removing other subscribers', () => {
  const { catalog } = fixture();
  const closed = jest.fn();
  const active = jest.fn();
  const unsubscribe = catalog.observe(closed);
  catalog.observe(active);
  expect(typeof unsubscribe).toBe('function');
  if (typeof unsubscribe !== 'function') return;
  (unsubscribe as () => void)();
  catalog.markStale();
  expect(closed).not.toHaveBeenCalled();
  expect(active).toHaveBeenCalledTimes(1);
});

it('does not retry a failed initial discovery when settings reopen', async () => {
  const { catalog, discover } = fixture();
  discover.mockRejectedValueOnce(new Error('Offline'));
  await catalog.refresh();
  await catalog.refresh();
  expect(discover).toHaveBeenCalledTimes(1);
  expect(catalog.getSnapshot()).toMatchObject({ status: 'failed', error: 'Offline' });
  await catalog.refresh({ force: true });
  expect(discover).toHaveBeenCalledTimes(2);
  expect(catalog.getSnapshot()).toMatchObject({ status: 'ready', error: undefined });
});


it.each<{ change: ProviderModelSelectionChange; expected: string[] }>([
  { change: { type: 'move', modelId: 'c', target: 'a' }, expected: ['c', 'a', 'b'] },
  { change: { type: 'move', modelId: 'a', target: 'c' }, expected: ['b', 'c', 'a'] },
  { change: { type: 'move', modelId: 'a', target: -1 }, expected: ['a', 'b', 'c'] },
  { change: { type: 'move', modelId: 'c', target: 1 }, expected: ['a', 'b', 'c'] },
  { change: { type: 'move', modelId: 'missing', target: 'a' }, expected: ['a', 'b', 'c'] },
  { change: { type: 'move', modelId: 'a', target: 'missing' }, expected: ['a', 'b', 'c'] },
  { change: { type: 'set', modelId: ' b ', selected: true }, expected: ['a', 'b', 'c'] },
  { change: { type: 'set', modelId: ' b ', selected: false }, expected: ['a', 'c'] },
])('applies selection intent $change without changing other identities', async ({ change, expected }) => {
  const settings = { visibleModels: ['a', 'b', 'c'] };
  const catalog = new ProviderModelCatalogController({
    providerId: 'example', providerName: 'Example',
    read: (draft = settings) => ({ enabled: true, models: [], selectedIds: draft.visibleModels as string[], aliases: {} }),
    discover: async () => ({ changed: false }),
    update: (draft, patch) => { Object.assign(draft, patch); },
    host: {
      mutateSettings: async mutate => { await mutate(settings as any); },
      notifyProviderChatOptionsChanged: jest.fn(),
    },
  });
  await catalog.changeSelection(change);
  expect(settings.visibleModels).toEqual(expected);
  await catalog.dispose();
});
