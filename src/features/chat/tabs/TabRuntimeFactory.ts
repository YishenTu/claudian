import type { Component } from 'obsidian';

import type { ProviderId } from '@/core/providers/types';
import type { Conversation } from '@/core/types';
import type { TabAttention } from '@/features/chat/state/types';
import type { FeatureHost } from '@/features/FeatureHost';

import {
  assembleTabRuntime,
  type ForkContext,
  type TabRuntimeCleanup,
} from './Tab';
import type {
  AssembledTabRuntime,
  ProviderCatalogInfo,
  TabId,
  TabProviderCatalogContext,
  TabRuntimeCleanupFailure,
  TabRuntimeResourceOwner,
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
