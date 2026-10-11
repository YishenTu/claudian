import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import type {
  PublishedTabRuntimeRef,
  TabRuntimeCleanup,
  TabRuntimeControllerBundle,
  TabRuntimeCore,
  TabRuntimeFactoryOptions,
} from '@/features/chat/tabs/runtime/TabRuntimeConstruction';
import { buildTabRuntimeControllers } from '@/features/chat/tabs/runtime/TabRuntimeControllers';
import { buildTabRuntimeCore } from '@/features/chat/tabs/runtime/TabRuntimeCore';
import { buildTabRuntimeInputBindings } from '@/features/chat/tabs/runtime/TabRuntimeInputBindings';
import { buildTabRuntimePorts } from '@/features/chat/tabs/runtime/TabRuntimePorts';
import { buildTabRuntimeUI } from '@/features/chat/tabs/runtime/TabRuntimeUI';
import {
  registerTabRuntimeResourceOwner,
  type TabRuntimeCleanupFailure,
  type TabRuntimeResourceOwner,
} from '@/features/chat/tabs/TabLifecycle';
import { applyProviderUIGating, refreshTabProviderUI } from '@/features/chat/tabs/tabProviderUI';
import type { AssembledTabRuntime, TabUIComponents } from '@/features/chat/tabs/types';

/** The factory is the only public entry to runtime construction, including its option type. */
export type { TabRuntimeFactoryOptions };

interface CleanupEntry {
  readonly cleanup: TabRuntimeCleanup;
  readonly resource: string;
}

class RuntimeResourceOwner implements TabRuntimeResourceOwner {
  private readonly entries: CleanupEntry[] = [];
  private disposal: Promise<readonly TabRuntimeCleanupFailure[]> | null = null;
  private sealed = false;

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
  core: TabRuntimeCore,
  ui: TabUIComponents,
  controllerBundle: TabRuntimeControllerBundle,
  plugin: ChatFeatureHost,
): AssembledTabRuntime {
  const ports = buildTabRuntimePorts(core.dom, ui, controllerBundle, plugin, () => runtime);
  const runtime: AssembledTabRuntime = {
    session: core.session,
    get id() {
      return core.id;
    },
    get lifecycleState() {
      return core.lifecycleState;
    },
    get hydrationState() {
      return core.hydrationState;
    },
    set hydrationState(value) {
      core.hydrationState = value;
    },
    get draftModel() {
      return core.draftModel;
    },
    get label() {
      return core.session.label ?? undefined;
    },
    get providerId() {
      return core.providerId;
    },
    get conversationId() {
      return core.conversationId;
    },
    executionCoordinator: core.executionCoordinator,
    providerCatalogResolver: core.providerCatalogResolver,
    captureReviewableSettlement: core.captureReviewableSettlement,
    state: core.state,
    controllers: controllerBundle.controllers,
    services: core.services,
    ui,
    dom: core.dom,
    renderer: controllerBundle.renderer,
    ...ports,
  };
  return runtime;
}

function assembleTabRuntime(
  options: TabRuntimeFactoryOptions,
  resourceOwner: RuntimeResourceOwner,
): AssembledTabRuntime {
  const context = {
    ...options,
    registerCleanup: (resource: string, cleanup: TabRuntimeCleanup) => resourceOwner.register(resource, cleanup),
  };
  const runtimeRef = createPublishedTabRuntimeRef();
  const core = buildTabRuntimeCore(context);
  const ui = buildTabRuntimeUI(core, context, runtimeRef);
  const controllerBundle = buildTabRuntimeControllers(core, ui, context, runtimeRef);
  buildTabRuntimeInputBindings(core, ui, controllerBundle.controllers, context, runtimeRef);
  const runtime = composeTabRuntime(core, ui, controllerBundle, options.plugin);
  registerTabRuntimeResourceOwner(runtime, resourceOwner);
  runtimeRef.publish(runtime);
  core.session.runtime.model.attach(controllerBundle.presentation);
  resourceOwner.register('tab session presentation', () => core.session.runtime.peekModel?.detach(controllerBundle.presentation));

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
    const runtime = assembleTabRuntime(options, resourceOwner);
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
