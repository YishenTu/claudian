/**
 * Lazy, memoized initialization boundary for provider workspace services.
 *
 * Providers are initialized only on first use. Each provider owns a single
 * initialization promise so concurrent callers cannot repeat work.
 */

import type { ProviderHost } from './ProviderHost';
import type {
  ProviderEnvironmentTransition,
  ProviderId,
  ProviderWorkspaceInitContext,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from './types';

interface ProviderTransitionGate {
  holds: number;
  opened: Promise<void>;
  open(): void;
}

interface ProviderInitializationAttempt {
  invalidated: Promise<void>;
  invalidate(): void;
  promise: Promise<void>;
}

export class ProviderInitializationBoundary {
  private registrations: Partial<Record<ProviderId, ProviderWorkspaceRegistration>> = {};
  private services: Partial<Record<ProviderId, ProviderWorkspaceServices>> = {};
  private initAttempts: Partial<Record<ProviderId, ProviderInitializationAttempt>> = {};
  private transitionGates: Partial<Record<ProviderId, ProviderTransitionGate>> = {};
  private generation = 0;

  getRegisteredProviderIds(): ProviderId[] {
    return Object.keys(this.registrations);
  }

  setServices(
    providerId: ProviderId,
    services: ProviderWorkspaceServices | undefined,
  ): void {
    if (services) {
      this.services[providerId] = services;
    } else {
      delete this.services[providerId];
      this.initAttempts[providerId]?.invalidate();
      delete this.initAttempts[providerId];
    }
  }

  register(
    providerId: ProviderId,
    registration: ProviderWorkspaceRegistration,
  ): void {
    this.registrations[providerId] = registration;
  }

  async ensureInitialized(
    plugin: ProviderHost,
    providerId: ProviderId,
    _reason: string,
  ): Promise<void> {
    if (this.services[providerId]) {
      await this.waitForProviderTransitions(providerId);
      return;
    }

    const existing = this.initAttempts[providerId];
    if (existing) {
      await existing.promise;
      await this.waitForProviderTransitions(providerId);
      return;
    }

    const promise = this.runInitialize(plugin, providerId, this.generation);
    let invalidate!: () => void;
    const attempt: ProviderInitializationAttempt = {
      invalidated: new Promise<void>(resolve => { invalidate = resolve; }),
      invalidate,
      promise,
    };
    this.initAttempts[providerId] = attempt;
    try {
      await promise;
    } finally {
      if (this.initAttempts[providerId] === attempt) {
        delete this.initAttempts[providerId];
        attempt.invalidate();
      }
    }
    await this.waitForProviderTransitions(providerId);
  }

  async beginEnvironmentChange(
    providerIds: ProviderId[],
  ): Promise<ProviderEnvironmentTransition> {
    const orderedProviderIds = [...new Set(providerIds)].sort();
    const releaseGates = orderedProviderIds.map(providerId => (
      this.holdProviderTransitions(providerId)
    ));
    const providerTransitions: ProviderEnvironmentTransition[] = [];

    try {
      for (const providerId of orderedProviderIds) {
        const initialization = this.initAttempts[providerId];
        if (initialization) {
          await Promise.race([
            initialization.promise.then(() => undefined, () => undefined),
            initialization.invalidated,
          ]);
        }
        const transition = await this.services[providerId]
          ?.beginAuxiliaryServicesEnvironmentChange?.();
        if (transition) {
          providerTransitions.push(transition);
        }
      }
    } catch (error) {
      await Promise.allSettled(
        providerTransitions.reverse().map(transition => transition.release()),
      );
      releaseGates.reverse().forEach(release => release());
      throw error;
    }

    let released = false;
    return {
      async release() {
        if (released) {
          return;
        }
        released = true;
        const results = await Promise.allSettled(
          providerTransitions.reverse().map(transition => transition.release()),
        );
        releaseGates.reverse().forEach(release => release());
        const failure = results.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        if (failure) {
          throw failure.reason;
        }
      },
    };
  }

  getIfInitialized(providerId: ProviderId): ProviderWorkspaceServices | null {
    return this.services[providerId] ?? null;
  }

  async disposeInitialized(): Promise<void> {
    this.generation += 1;
    const promises: Promise<void>[] = [];
    for (const [providerId, services] of Object.entries(this.services)) {
      if (!services) continue;
      const dispose = services.dispose?.bind(services);
      if (dispose) {
        promises.push(Promise.resolve(dispose()));
      }
      delete this.services[providerId];
    }
    for (const attempt of Object.values(this.initAttempts)) {
      attempt?.invalidate();
    }
    this.initAttempts = {};
    await Promise.allSettled(promises);
  }

  private holdProviderTransitions(providerId: ProviderId): () => void {
    let gate = this.transitionGates[providerId];
    if (!gate) {
      let open!: () => void;
      gate = {
        holds: 0,
        opened: new Promise<void>(resolve => { open = resolve; }),
        open,
      };
      this.transitionGates[providerId] = gate;
    }
    gate.holds += 1;

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      gate.holds -= 1;
      if (gate.holds === 0 && this.transitionGates[providerId] === gate) {
        delete this.transitionGates[providerId];
        gate.open();
      }
    };
  }

  private async waitForProviderTransitions(providerId: ProviderId): Promise<void> {
    while (this.transitionGates[providerId]) {
      await this.transitionGates[providerId]?.opened;
    }
  }

  private async runInitialize(
    plugin: ProviderHost,
    providerId: ProviderId,
    generation: number,
  ): Promise<void> {
    const registration = this.registrations[providerId];
    if (!registration) {
      throw new Error(`Provider workspace "${providerId}" is not registered.`);
    }

    const storage = plugin.storage;
    const vaultAdapter = storage.getAdapter();
    const { HomeFileAdapter } = await import('../storage/HomeFileAdapter');
    const homeAdapter = new HomeFileAdapter();

    const context: ProviderWorkspaceInitContext = {
      plugin,
      storage,
      vaultAdapter,
      homeAdapter,
    };

    const services = await registration.initialize(context);
    if (generation !== this.generation) {
      if (typeof services.dispose === 'function') {
        await Promise.resolve()
          .then(() => services.dispose?.())
          .catch(() => undefined);
      }
      return;
    }

    this.services[providerId] = services;
  }
}
