import type { Component } from 'obsidian';

import type { ProviderId } from '@/core/providers/types';
import type { Conversation } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import type { ForkContext } from '@/features/chat/conversation/forkSourceTypes';
import type { ChatExecutionCoordinator } from '@/features/chat/execution/ChatExecutionCoordinator';
import type { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import type { SessionPresentation } from '@/features/chat/sessions/SessionModel';
import type { ChatState } from '@/features/chat/state/ChatState';
import type { TabAttention, TabReviewOutcome } from '@/features/chat/state/types';
import type { TabId } from '@/features/chat/tabs/ChatTab';
import type { TabIdentity } from '@/features/chat/tabs/TabIdentity';
import type { TabSession } from '@/features/chat/tabs/TabSession';
import type { AssembledTabRuntime, ProviderCatalogInfo, ProviderCatalogResolver, TabControllers, TabDOMElements, TabServices } from '@/features/chat/tabs/types';
import type { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

export type TabRuntimeCleanup = () => void | Promise<void>;

/** What a tab runtime is assembled from: host resources, its identity, and manager callbacks. */
export interface TabRuntimeFactoryOptions {
  revealSession?: (isCurrent?: () => boolean) => void | Promise<void>;
  plugin: ChatFeatureHost;
  containerEl: HTMLElement;
  component: Component;
  mentionDataProvider: VaultMentionDataProvider;
  conversation?: Conversation;
  tabId?: TabId;
  initialState?: Readonly<TabIdentity>;
  draftModel?: string | null;
  providerId?: ProviderId | null;
  lifecycleState?: Extract<AssembledTabRuntime['lifecycleState'], 'provisional' | 'open'>;
  /** A held draft session the new tab reattaches instead of starting a fresh draft. */
  draftSessionKey?: string;
  getProviderCatalogConfig: (tab: Readonly<TabIdentity>) => ProviderCatalogInfo;
  isRuntimeLive: (tab: AssembledTabRuntime) => boolean;
  forkRequestCallback?: (forkContext: ForkContext) => Promise<void>;
  /** Opens a session this tab's command picked; the manager binds it to this tab. */
  openConversation: (conversationId: string) => Promise<void>;
  /** Starts a new conversation this tab's command requested (/new). */
  startNewConversation: () => Promise<void>;
  onStreamingChanged?: (tab: AssembledTabRuntime, isStreaming: boolean) => void;
  onWorkChanged?: (tab: AssembledTabRuntime) => void;
  onRewindingChanged?: (tab: AssembledTabRuntime, isRewinding: boolean) => void;
  onAttentionChanged?: (tab: AssembledTabRuntime, attention: TabAttention) => void;
  onConversationIdChanged?: (tab: AssembledTabRuntime, conversationId: string | null) => void;
  onDraftModelChanged?: (tab: AssembledTabRuntime, draftModel: string | null) => void;
  onProviderChanged?: (tab: AssembledTabRuntime, providerId: ProviderId) => void | Promise<void>;
  onCommandContextChanged?: (tab: AssembledTabRuntime) => void;
  captureReviewableSettlement?: (tab: AssembledTabRuntime, outcome: TabReviewOutcome) => () => void;
}

/** Factory options plus the cleanup registry every assembly stage acquires resources through. */
export interface TabRuntimeConstructionContext extends TabRuntimeFactoryOptions {
  registerCleanup: (resource: string, cleanup: TabRuntimeCleanup) => void;
}

export interface PublishedTabRuntimeRef {
  requirePublished(): AssembledTabRuntime;
  current(): AssembledTabRuntime | null;
  publish(runtime: AssembledTabRuntime): void;
}

/** The first assembly stage: identity-backed session, presentation state, execution, DOM, and services. */
export interface TabRuntimeCore extends Readonly<TabIdentity> {
  readonly session: TabSession;
  readonly id: TabId;
  hydrationState: AssembledTabRuntime['hydrationState'];
  readonly executionCoordinator: ChatExecutionCoordinator;
  readonly providerCatalogResolver: ProviderCatalogResolver;
  readonly captureReviewableSettlement: ((outcome: TabReviewOutcome) => () => void) | null;
  readonly state: ChatState;
  readonly dom: TabDOMElements;
  readonly services: TabServices;
}

export interface TabRuntimeControllerBundle {
  readonly controllers: TabControllers;
  readonly renderer: MessageRenderer;
  readonly presentation: SessionPresentation;
}
