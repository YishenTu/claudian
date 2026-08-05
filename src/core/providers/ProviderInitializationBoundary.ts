/**
 * Lazy, memoized initialization boundary for provider workspace services.
 *
 * Providers are initialized only on first use. Each provider owns a single
 * initialization promise so concurrent callers cannot repeat work.
 */

import type { ProviderExecutionTransitionScope } from '../execution';
import type { ProviderHost } from './ProviderHost';
import type {
  ProviderId,
  ProviderWorkspaceInitContext,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from './types';

interface ProviderInitializationAttempt {
  promise: Promise<void>;
}

export class ProviderInitializationBoundary {
  private registrations: Partial<Record<ProviderId, ProviderWorkspaceRegistration>> = {};
  private services: Partial<Record<ProviderId, ProviderWorkspaceServices>> = {};
  private initAttempts: Partial<Record<ProviderId, ProviderInitializationAttempt>> = {};
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
      return;
    }

    const existing = this.initAttempts[providerId];
    if (existing) {
      await existing.promise;
      return;
    }

    const generation = this.generation;
    const promise = plugin.runProviderExecutionTransition(
      [providerId],
      (transitionScope) => this.runInitialize(
        plugin,
        providerId,
        generation,
        transitionScope,
      ),
    );
    const attempt: ProviderInitializationAttempt = {
      promise,
    };
    this.initAttempts[providerId] = attempt;
    try {
      await promise;
    } finally {
      if (this.initAttempts[providerId] === attempt) {
        delete this.initAttempts[providerId];
      }
    }
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
    this.initAttempts = {};
    await Promise.allSettled(promises);
  }

  private async runInitialize(
    plugin: ProviderHost,
    providerId: ProviderId,
    generation: number,
    transitionScope: ProviderExecutionTransitionScope,
  ): Promise<void> {
    const registration = this.registrations[providerId];
    if (!registration) {
      throw new Error(`Provider workspace "${providerId}" is not registered.`);
    }

    const storage = plugin.storage;
    const vaultAdapter = storage.getAdapter();

    const context: ProviderWorkspaceInitContext = {
      plugin,
      storage,
      vaultAdapter,
      transitionScope,
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
