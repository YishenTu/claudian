/**
 * Lazy, memoized initialization boundary for provider workspace services.
 *
 * Providers are initialized only on first use. Each provider owns a single
 * initialization promise so concurrent callers cannot repeat work.
 */

import type { ProviderHost } from './ProviderHost';
import type {
  ProviderId,
  ProviderWorkspaceInitContext,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from './types';

export class ProviderInitializationBoundary {
  private registrations: Partial<Record<ProviderId, ProviderWorkspaceRegistration>> = {};
  private services: Partial<Record<ProviderId, ProviderWorkspaceServices>> = {};
  private initPromises: Partial<Record<ProviderId, Promise<void>>> = {};
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
      delete this.initPromises[providerId];
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

    const existing = this.initPromises[providerId];
    if (existing) {
      return existing;
    }

    const promise = this.runInitialize(plugin, providerId, this.generation);
    this.initPromises[providerId] = promise;
    try {
      await promise;
    } finally {
      if (this.initPromises[providerId] === promise) {
        delete this.initPromises[providerId];
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
      const dispose = services.dispose;
      if (typeof dispose === 'function') {
        promises.push(Promise.resolve().then(() => dispose.call(services)));
      }
      delete this.services[providerId];
    }
    this.initPromises = {};
    await Promise.allSettled(promises);
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
