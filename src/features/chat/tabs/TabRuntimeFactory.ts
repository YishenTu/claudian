import type { Component } from 'obsidian';

import type { ProviderId } from '@/core/providers/types';
import type { Conversation } from '@/core/types';
import type { TabAttention } from '@/features/chat/state/types';
import type { FeatureHost } from '@/features/FeatureHost';

import type {
  PublishedTabRuntimeRef,
  TabRuntimeCleanup,
  TabRuntimeConstructionContext,
  TabRuntimeControllerBundle,
  TabRuntimeShellBundle,
} from './runtime/TabRuntimeConstruction';
import { buildTabRuntimeControllers } from './runtime/TabRuntimeControllers';
import { buildTabRuntimeInputBindings } from './runtime/TabRuntimeInputBindings';
import { buildTabRuntimeServices } from './runtime/TabRuntimeServices';
import { buildTabRuntimeShell } from './runtime/TabRuntimeShell';
import { buildTabRuntimeUI } from './runtime/TabRuntimeUI';
import type { ForkContext } from './TabForking';
import { registerTabRuntimeResourceOwner } from './TabLifecycle';
import {
  applyProviderUIGating,
  refreshTabProviderUI,
} from './TabProviderState';
import type {
  AssembledTabRuntime,
  ProviderCatalogInfo,
  TabId,
  TabInputBindings,
  TabProviderCatalogContext,
  TabRuntimeCleanupFailure,
  TabRuntimeResourceOwner,
  TabServices,
  TabUIComponents,
} from './types';

export interface TabRuntimeFactoryOptions {
  plugin: FeatureHost;
  containerEl: HTMLElement;
  component: Component;
  conversation?: Conversation;
  tabId?: TabId;
  draftModel?: string | null;
  lifecycleState?: Extract<
    AssembledTabRuntime['lifecycleState'],
    'provisional' | 'cold'
  >;
  getProviderCatalogConfig: (
    tab: TabProviderCatalogContext,
  ) => ProviderCatalogInfo;
  isRuntimeLive: (tab: AssembledTabRuntime) => boolean;
  forkRequestCallback?: (forkContext: ForkContext) => Promise<void>;
  openConversation?: (conversationId: string) => Promise<void>;
  onStreamingChanged?: (tab: AssembledTabRuntime, isStreaming: boolean) => void;
  onRewindingChanged?: (tab: AssembledTabRuntime, isRewinding: boolean) => void;
  onAttentionChanged?: (tab: AssembledTabRuntime, attention: TabAttention) => void;
  onConversationIdChanged?: (
    tab: AssembledTabRuntime,
    conversationId: string | null,
  ) => void;
  onProviderChanged?: (
    tab: AssembledTabRuntime,
    providerId: ProviderId,
  ) => void | Promise<void>;
  onCommandContextChanged?: (tab: AssembledTabRuntime) => void;
  captureReviewableSettlement?: (tab: AssembledTabRuntime) => () => void;
}

interface CleanupEntry {
  readonly cleanup: TabRuntimeCleanup;
  readonly resource: string;
}

class RuntimeResourceOwner implements TabRuntimeResourceOwner {
  private readonly entries: CleanupEntry[] = [];
  private disposal: Promise<readonly TabRuntimeCleanupFailure[]> | null = null;
  private sealed = false;

  get isDisposed(): boolean {
    return this.disposal !== null;
  }

  register(resource: string, cleanup: TabRuntimeCleanup): void {
    if (this.sealed || this.disposal) {
      throw new Error(`Cannot acquire ${resource} after tab runtime assembly`);
    }
    this.entries.push({ cleanup, resource });
  }

  seal(): void {
    this.sealed = true;
  }

  dispose(): Promise<readonly TabRuntimeCleanupFailure[]> {
    if (!this.disposal) {
      this.sealed = true;
      this.disposal = this.disposeEntries();
    }
    return this.disposal;
  }

  private async disposeEntries(): Promise<readonly TabRuntimeCleanupFailure[]> {
    const failures: TabRuntimeCleanupFailure[] = [];
    const entries = this.entries.splice(0).reverse();
    for (const entry of entries) {
      try {
        await entry.cleanup();
      } catch (error) {
        failures.push({ error, resource: entry.resource });
      }
    }
    return failures;
  }
}

export class TabRuntimeConstructionError extends Error {
  readonly rollbackFailures: readonly TabRuntimeCleanupFailure[];

  constructor(cause: unknown, rollbackFailures: readonly TabRuntimeCleanupFailure[]) {
    const resources = rollbackFailures.map(failure => failure.resource).join(', ');
    super(`Tab runtime construction failed and rollback also failed: ${resources}`, { cause });
    this.name = 'TabRuntimeConstructionError';
    this.rollbackFailures = rollbackFailures;
  }
}

function createPublishedTabRuntimeRef(): PublishedTabRuntimeRef {
  let publishedRuntime: AssembledTabRuntime | null = null;
  return {
    requirePublished: () => {
      if (!publishedRuntime) {
        throw new Error('Tab runtime callback invoked before assembly completed');
      }
      return publishedRuntime;
    },
    current: () => publishedRuntime,
    publish: (runtime) => {
      if (publishedRuntime) {
        throw new Error('Tab runtime was published more than once');
      }
      publishedRuntime = runtime;
    },
  };
}

function composeTabRuntime(
  shell: TabRuntimeShellBundle,
  services: TabServices,
  ui: TabUIComponents,
  controllerBundle: TabRuntimeControllerBundle,
  inputBindings: TabInputBindings,
  resourceOwner: TabRuntimeResourceOwner,
): AssembledTabRuntime {
  return {
    session: shell.session,
    get id() {
      return shell.id;
    },
    get lifecycleState() {
      return shell.lifecycleState;
    },
    set lifecycleState(value) {
      shell.lifecycleState = value;
    },
    get hydrationState() {
      return shell.hydrationState;
    },
    set hydrationState(value) {
      shell.hydrationState = value;
    },
    get draftModel() {
      return shell.draftModel;
    },
    set draftModel(value) {
      shell.draftModel = value;
    },
    get providerId() {
      return shell.providerId;
    },
    set providerId(value) {
      shell.providerId = value;
    },
    get conversationId() {
      return shell.conversationId;
    },
    set conversationId(value) {
      shell.conversationId = value;
    },
    executionCoordinator: shell.executionCoordinator,
    providerCatalogResolver: shell.providerCatalogResolver,
    captureReviewableSettlement: shell.captureReviewableSettlement,
    state: shell.state,
    controllers: controllerBundle.controllers,
    services,
    ui,
    dom: shell.dom,
    renderer: controllerBundle.renderer,
    inputBindings,
    resources: {
      get isDisposed() {
        return resourceOwner.isDisposed;
      },
    },
  };
}

function assembleTabRuntime(
  options: TabRuntimeConstructionContext,
): AssembledTabRuntime {
  const runtimeRef = createPublishedTabRuntimeRef();
  const shell = buildTabRuntimeShell(options, runtimeRef);
  const services = buildTabRuntimeServices(shell, options, runtimeRef);
  const ui = buildTabRuntimeUI(shell, services, options, runtimeRef);
  const controllerBundle = buildTabRuntimeControllers(
    shell,
    services,
    ui,
    options,
    runtimeRef,
  );
  const inputBindings = buildTabRuntimeInputBindings(
    shell,
    ui,
    controllerBundle.controllers,
    options,
    runtimeRef,
  );
  const runtime = composeTabRuntime(
    shell,
    services,
    ui,
    controllerBundle,
    inputBindings,
    options.resourceOwner,
  );
  registerTabRuntimeResourceOwner(runtime, options.resourceOwner);
  runtimeRef.publish(runtime);

  refreshTabProviderUI(runtime, options.plugin);
  applyProviderUIGating(runtime, options.plugin);
  return runtime;
}

/** Creates a structurally complete tab runtime or rolls back every acquired resource. */
export async function createTabRuntime(
  options: TabRuntimeFactoryOptions,
): Promise<AssembledTabRuntime> {
  const resourceOwner = new RuntimeResourceOwner();

  try {
    const runtime = assembleTabRuntime({
      ...options,
      registerCleanup: (resource, cleanup) => resourceOwner.register(resource, cleanup),
      resourceOwner,
    });
    resourceOwner.seal();
    return runtime;
  } catch (error) {
    const rollbackFailures = await resourceOwner.dispose();
    if (rollbackFailures.length > 0) {
      throw new TabRuntimeConstructionError(error, rollbackFailures);
    }
    throw error;
  }
}
