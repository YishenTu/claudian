import type { Component } from 'obsidian';

import type { ProviderId } from '@/core/providers/types';
import type { Conversation } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import type { ForkContext } from '@/features/chat/conversation/forkSourceTypes';
import type { TabAttention, TabReviewOutcome } from '@/features/chat/state/types';
import type { TabId, TabProviderCatalogContext } from '@/features/chat/tabs/ChatTab';
import type {
  PublishedTabRuntimeRef,
  TabRuntimeCleanup,
  TabRuntimeConstructionContext,
  TabRuntimeControllerBundle,
  TabRuntimeShellBundle,
} from '@/features/chat/tabs/runtime/TabRuntimeConstruction';
import { buildTabRuntimeControllers } from '@/features/chat/tabs/runtime/TabRuntimeControllers';
import { buildTabRuntimeInputBindings } from '@/features/chat/tabs/runtime/TabRuntimeInputBindings';
import { buildTabRuntimePorts } from '@/features/chat/tabs/runtime/TabRuntimePorts';
import { buildTabRuntimeServices } from '@/features/chat/tabs/runtime/TabRuntimeServices';
import { buildTabRuntimeShell } from '@/features/chat/tabs/runtime/TabRuntimeShell';
import { buildTabRuntimeUI } from '@/features/chat/tabs/runtime/TabRuntimeUI';
import {
  registerTabRuntimeResourceOwner,
  type TabRuntimeCleanupFailure,
  type TabRuntimeResourceOwner,
} from '@/features/chat/tabs/TabLifecycle';
import { applyProviderUIGating, refreshTabProviderUI } from '@/features/chat/tabs/tabProviderUI';
import type { TabSessionState } from '@/features/chat/tabs/TabSession';
import type { AssembledTabRuntime, ProviderCatalogInfo, TabInputBindings, TabServices, TabUIComponents } from '@/features/chat/tabs/types';
import type { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

export interface TabRuntimeFactoryOptions {
  plugin: ChatFeatureHost;
  containerEl: HTMLElement;
  component: Component;
  mentionDataProvider: VaultMentionDataProvider;
  conversation?: Conversation;
  tabId?: TabId;
  initialState?: Readonly<TabSessionState>;
  draftModel?: string | null;
  providerId?: ProviderId | null;
  lifecycleState?: Extract<
    AssembledTabRuntime['lifecycleState'],
    'provisional' | 'open'
  >;
  getProviderCatalogConfig: (
    tab: TabProviderCatalogContext,
  ) => ProviderCatalogInfo;
  isRuntimeLive: (tab: AssembledTabRuntime) => boolean;
  forkRequestCallback?: (forkContext: ForkContext) => Promise<void>;
  openConversation?: (conversationId: string) => Promise<void>;
  onStreamingChanged?: (tab: AssembledTabRuntime, isStreaming: boolean) => void;
  onWorkChanged?: (tab: AssembledTabRuntime) => void;
  onRewindingChanged?: (tab: AssembledTabRuntime, isRewinding: boolean) => void;
  onAttentionChanged?: (tab: AssembledTabRuntime, attention: TabAttention) => void;
  onConversationIdChanged?: (
    tab: AssembledTabRuntime,
    conversationId: string | null,
  ) => void;
  onDraftModelChanged?: (
    tab: AssembledTabRuntime,
    draftModel: string | null,
  ) => void;
  onProviderChanged?: (
    tab: AssembledTabRuntime,
    providerId: ProviderId,
  ) => void | Promise<void>;
  onCommandContextChanged?: (tab: AssembledTabRuntime) => void;
  captureReviewableSettlement?: (
    tab: AssembledTabRuntime,
    outcome: TabReviewOutcome,
  ) => () => void;
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
      this.disposal = this.#disposeEntries();
    }
    return this.disposal;
  }

  async #disposeEntries(): Promise<readonly TabRuntimeCleanupFailure[]> {
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
  plugin: ChatFeatureHost,
): AssembledTabRuntime {
  const ports = buildTabRuntimePorts(shell.dom, ui, controllerBundle, plugin, () => runtime);
  const runtime: AssembledTabRuntime = {
    session: shell.session,
    get id() {
      return shell.id;
    },
    get lifecycleState() {
      return shell.lifecycleState;
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
    get providerId() {
      return shell.providerId;
    },
    get conversationId() {
      return shell.conversationId;
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
    ...ports,
  };
  return runtime;
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
    options.plugin,
  );
  registerTabRuntimeResourceOwner(runtime, options.resourceOwner);
  runtimeRef.publish(runtime);

  refreshTabProviderUI(runtime);
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
