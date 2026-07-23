import type { query as qoderQuery } from '@qoder-ai/qoder-agent-sdk';

import type * as QoderSdkModule from './qoderSdkModule';

let modulePromise: Promise<typeof QoderSdkModule> | undefined;
let loadedModule: typeof QoderSdkModule | undefined;

/**
 * Lazily import the Qoder SDK module. The SDK is ESM with top-level
 * `import.meta.url` usage, so it must stay behind a dynamic import to avoid
 * eager evaluation at plugin startup.
 */
export async function loadQoderSdkModule(): Promise<typeof QoderSdkModule> {
  modulePromise ??= import('./qoderSdkModule');
  loadedModule = await modulePromise;
  return loadedModule;
}

export async function loadQoderQuery(): Promise<typeof qoderQuery> {
  return (await loadQoderSdkModule()).query;
}

/**
 * Synchronous accessor for the already-loaded SDK module. Callers must have
 * awaited {@link loadQoderQuery} or {@link loadQoderSdkModule} first; this keeps
 * synchronous option builders (e.g. auth resolution) off the eager import path.
 */
export function getLoadedQoderSdk(): typeof QoderSdkModule {
  if (!loadedModule) {
    throw new Error('Qoder SDK is not loaded yet. Call loadQoderSdkModule() first.');
  }
  return loadedModule;
}
