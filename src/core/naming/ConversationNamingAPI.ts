export type NamingMode = 'both' | 'long' | 'short';
export type NamingStatus = 'pending' | 'success' | 'failed' | undefined;

export interface NamingConversationSnapshot {
  readonly conversationId: string;
  readonly createdAt: number;
  readonly longTitle: string;
  readonly shortTitle: string | null;
}

export interface NamingTitleUpdate {
  readonly expectedLongTitle?: string;
  readonly expectedShortTitle?: string | null;
  readonly longTitle?: string;
  readonly shortTitle?: string;
}

export interface NamingTitleResult {
  readonly longTitle: boolean;
  readonly shortTitle: boolean;
}

export interface NamingFirstTurnEvent {
  readonly conversationId: string;
  readonly visibleUserText: string;
}

export interface NamingTextTask {
  readonly prompt: string;
  readonly systemPrompt: string;
  readonly timeoutMs?: number;
}

/** Feature-detect with `plugin.namingApi?.version === 1`; no repository or session is exposed. */
export interface ConversationNamingAPI {
  readonly version: 1;
  hasFirstTurnSubscriber(): boolean;
  getActiveConversationId(): string | null;
  getConversationSnapshot(id: string): NamingConversationSnapshot | null;
  listConversationSnapshots(): readonly NamingConversationSnapshot[];
  getFirstUserText(id: string): Promise<string | null>;
  subscribeFirstTurn(listener: (event: NamingFirstTurnEvent) => void | Promise<void>): () => void;
  subscribeRegeneration(listener: (event: { conversationId: string; mode: NamingMode }) => void | Promise<void>): () => void;
  requestRegeneration(event: { conversationId: string; mode: NamingMode }): boolean;
  runAuxiliaryTextTask(request: NamingTextTask): Promise<string>;
  setGenerationStatus(id: string, status: NamingStatus): Promise<boolean>;
  updateTitles(id: string, update: NamingTitleUpdate): Promise<NamingTitleResult>;
}
