import {
  TabModelSelectionCoordinator,
  type TabModelSelectionDraft,
} from '@/features/chat/tabs/TabModelSelectionCoordinator';

interface Deferred {
  promise: Promise<void>;
  reject(error: Error): void;
  resolve(): void;
}

function deferred(): Deferred {
  let reject!: (error: Error) => void;
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createHarness() {
  let draft: TabModelSelectionDraft = {
    providerId: 'claude',
    model: 'claude-default',
  };
  const initializations = new Map<string, Deferred>();
  const initializeProvider = jest.fn((providerId: string) => {
    const transition = initializations.get(providerId) ?? deferred();
    initializations.set(providerId, transition);
    return transition.promise;
  });
  const restoreDraft = jest.fn((restored: TabModelSelectionDraft) => {
    draft = { ...restored };
  });
  let ownerIsLive = true;
  const coordinator = new TabModelSelectionCoordinator({
    isOwnerLive: () => ownerIsLive,
    readDraft: () => ({ ...draft }),
    applyModel: (model) => { draft = { ...draft, model }; },
    applyProviderTarget: (target) => { draft = { ...target }; },
    restoreDraft,
    initializeProvider,
  });

  return {
    coordinator,
    getDraft: () => draft,
    getTransition(providerId: string) {
      const transition = initializations.get(providerId);
      if (!transition) throw new Error(`Missing transition for ${providerId}`);
      return transition;
    },
    initializeProvider,
    loseOwnership() {
      ownerIsLive = false;
    },
    restoreDraft,
  };
}

describe('TabModelSelectionCoordinator', () => {
  it('applies a same-provider model without starting a provider transition', async () => {
    const harness = createHarness();
    const request = harness.coordinator.beginRequest();

    const result = await harness.coordinator.selectBlank(request, {
      providerId: 'claude',
      model: 'claude-alternate',
    });

    expect(result.status).toBe('succeeded');
    expect(result.status === 'succeeded' && result.isCurrent()).toBe(true);
    expect(harness.getDraft()).toEqual({
      providerId: 'claude',
      model: 'claude-alternate',
    });
    expect(harness.initializeProvider).not.toHaveBeenCalled();
  });

  it('shares one successful initialization across same-provider choices', async () => {
    const harness = createHarness();
    const firstRequest = harness.coordinator.beginRequest();
    const first = harness.coordinator.selectBlank(firstRequest, {
      providerId: 'codex',
      model: 'codex-first',
    });
    const secondRequest = harness.coordinator.beginRequest();
    const second = harness.coordinator.selectBlank(secondRequest, {
      providerId: 'codex',
      model: 'codex-latest',
    });

    expect(harness.getDraft()).toEqual({
      providerId: 'codex',
      model: 'codex-latest',
    });
    expect(harness.initializeProvider).toHaveBeenCalledTimes(1);

    harness.getTransition('codex').resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.status).toBe('succeeded');
    expect(firstResult.status === 'succeeded' && firstResult.isCurrent()).toBe(false);
    expect(secondResult.status).toBe('succeeded');
    expect(secondResult.status === 'succeeded' && secondResult.isCurrent()).toBe(true);
    expect(harness.initializeProvider).toHaveBeenCalledTimes(1);
  });

  it('restores the stable draft when shared provider initialization fails', async () => {
    const harness = createHarness();
    const firstRequest = harness.coordinator.beginRequest();
    const first = harness.coordinator.selectBlank(firstRequest, {
      providerId: 'codex',
      model: 'codex-first',
    });
    const secondRequest = harness.coordinator.beginRequest();
    const second = harness.coordinator.selectBlank(secondRequest, {
      providerId: 'codex',
      model: 'codex-latest',
    });
    const error = new Error('Codex initialization failed');

    harness.getTransition('codex').reject(error);

    await expect(first).resolves.toEqual({ status: 'superseded' });
    await expect(second).rejects.toBe(error);
    expect(harness.getDraft()).toEqual({
      providerId: 'claude',
      model: 'claude-default',
    });
    expect(harness.restoreDraft).toHaveBeenCalledTimes(1);
  });

  it('does not restore a provider draft after its owner is disposed', async () => {
    const harness = createHarness();
    const request = harness.coordinator.beginRequest();
    const selection = harness.coordinator.selectBlank(request, {
      providerId: 'codex',
      model: 'codex-model',
    });

    harness.loseOwnership();
    harness.getTransition('codex').reject(new Error('Codex initialization failed'));

    await expect(selection).resolves.toEqual({ status: 'superseded' });
    expect(harness.restoreDraft).not.toHaveBeenCalled();
  });

  it('lets a newer provider transition continue after an older transition fails', async () => {
    const harness = createHarness();
    const firstRequest = harness.coordinator.beginRequest();
    const first = harness.coordinator.selectBlank(firstRequest, {
      providerId: 'codex',
      model: 'codex-model',
    });
    const secondRequest = harness.coordinator.beginRequest();
    const second = harness.coordinator.selectBlank(secondRequest, {
      providerId: 'grok',
      model: 'grok-model',
    });

    harness.getTransition('codex').reject(new Error('Codex initialization failed'));
    await expect(first).resolves.toEqual({ status: 'superseded' });
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(harness.getDraft()).toEqual({ providerId: 'grok', model: 'grok-model' });
    expect(harness.initializeProvider).toHaveBeenCalledTimes(2);

    harness.getTransition('grok').resolve();
    const result = await second;
    expect(result.status).toBe('succeeded');
    expect(result.status === 'succeeded' && result.isCurrent()).toBe(true);
  });

  it('restores the original stable draft when overlapping transitions both fail', async () => {
    const harness = createHarness();
    const firstRequest = harness.coordinator.beginRequest();
    const first = harness.coordinator.selectBlank(firstRequest, {
      providerId: 'codex',
      model: 'codex-model',
    });
    const secondRequest = harness.coordinator.beginRequest();
    const second = harness.coordinator.selectBlank(secondRequest, {
      providerId: 'grok',
      model: 'grok-model',
    });

    harness.getTransition('codex').reject(new Error('Codex initialization failed'));
    await expect(first).resolves.toEqual({ status: 'superseded' });
    await new Promise<void>(resolve => setImmediate(resolve));
    const grokError = new Error('Grok initialization failed');
    harness.getTransition('grok').reject(grokError);

    await expect(second).rejects.toBe(grokError);
    expect(harness.getDraft()).toEqual({
      providerId: 'claude',
      model: 'claude-default',
    });
    expect(harness.restoreDraft).toHaveBeenCalledTimes(2);
  });

  it('supersedes an intermediate request when three choices wait on one transition', async () => {
    const harness = createHarness();
    const firstRequest = harness.coordinator.beginRequest();
    const first = harness.coordinator.selectBlank(firstRequest, {
      providerId: 'codex',
      model: 'codex-first',
    });
    const secondRequest = harness.coordinator.beginRequest();
    const second = harness.coordinator.selectBlank(secondRequest, {
      providerId: 'grok',
      model: 'grok-model',
    });
    const thirdRequest = harness.coordinator.beginRequest();
    const third = harness.coordinator.selectBlank(thirdRequest, {
      providerId: 'codex',
      model: 'codex-latest',
    });

    harness.getTransition('codex').resolve();
    const [firstResult, secondResult, thirdResult] = await Promise.all([
      first,
      second,
      third,
    ]);

    expect(firstResult.status).toBe('succeeded');
    expect(secondResult).toEqual({ status: 'superseded' });
    expect(thirdResult.status).toBe('succeeded');
    expect(thirdResult.status === 'succeeded' && thirdResult.isCurrent()).toBe(true);
    expect(harness.getDraft()).toEqual({
      providerId: 'codex',
      model: 'codex-latest',
    });
    expect(harness.initializeProvider).toHaveBeenCalledTimes(1);
  });
});
