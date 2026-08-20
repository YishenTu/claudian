import type { Component } from 'obsidian';

import type { ProviderId } from '../../../../core/providers/types';
import type { Conversation } from '../../../../core/types';
import type { FeatureHost } from '../../../FeatureHost';
import type { ChatExecutionCoordinator } from '../../execution/ChatExecutionCoordinator';
import type { MessageRenderer } from '../../rendering/MessageRenderer';
import type { ChatState } from '../../state/ChatState';
import type { TabAttention, TabReviewOutcome } from '../../state/types';
import type { ForkContext } from '../TabForking';
import type { TabSession } from '../TabSession';
import type {
  AssembledTabRuntime,
  ProviderCatalogInfo,
  ProviderCatalogResolver,
  TabControllers,
  TabDOMElements,
  TabId,
  TabProviderCatalogContext,
  TabProviderContext,
  TabRuntimeResourceOwner,
} from '../types';

export type TabRuntimeCleanup = () => void | Promise<void>;

export interface TabRuntimeConstructionContext {
  plugin: FeatureHost;
  containerEl: HTMLElement;
  component: Component;
  conversation?: Conversation;
  tabId?: TabId;
  draftModel?: string | null;
  lifecycleState?: Extract<AssembledTabRuntime['lifecycleState'], 'provisional' | 'cold'>;
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
  onProviderChanged?: (
    tab: AssembledTabRuntime,
    providerId: ProviderId,
  ) => void | Promise<void>;
  onCommandContextChanged?: (tab: AssembledTabRuntime) => void;
  captureReviewableSettlement?: (
    tab: AssembledTabRuntime,
    outcome: TabReviewOutcome,
  ) => () => void;
  registerCleanup: (resource: string, cleanup: TabRuntimeCleanup) => void;
  resourceOwner: TabRuntimeResourceOwner;
}

export interface PublishedTabRuntimeRef {
  requirePublished(): AssembledTabRuntime;
  current(): AssembledTabRuntime | null;
  publish(runtime: AssembledTabRuntime): void;
}

export interface TabRuntimeShellBundle extends TabProviderContext {
  readonly session: TabSession;
  readonly id: TabId;
  hydrationState: AssembledTabRuntime['hydrationState'];
  readonly executionCoordinator: ChatExecutionCoordinator;
  readonly providerCatalogResolver: ProviderCatalogResolver;
  readonly captureReviewableSettlement: ((outcome: TabReviewOutcome) => () => void) | null;
  readonly state: ChatState;
  readonly dom: TabDOMElements;
}

export interface TabRuntimeControllerBundle {
  readonly controllers: TabControllers;
  readonly renderer: MessageRenderer;
}
