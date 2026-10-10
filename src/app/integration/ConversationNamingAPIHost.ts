import type {
  ConversationNamingAPI, NamingConversationSnapshot, NamingFirstTurnEvent,
  NamingMode, NamingStatus, NamingTextTask, NamingTitleResult, NamingTitleUpdate,
} from '@/core/naming/ConversationNamingAPI';

interface NamingHostDeps {
  getActiveConversationId(): string | null;
  getSnapshot(id: string): NamingConversationSnapshot | null;
  listSnapshots(): readonly NamingConversationSnapshot[];
  getFirstUserText(id: string): Promise<string | null>;
  updateTitles(id: string, update: NamingTitleUpdate): Promise<NamingTitleResult>;
  setGenerationStatus(id: string, status: NamingStatus): Promise<boolean>;
  runTextTask(request: NamingTextTask, signal: AbortSignal): Promise<string>;
}

/** Lifecycle and subscription boundary; naming policy remains in the subscriber. */
export class ConversationNamingAPIHost implements ConversationNamingAPI {
  readonly version = 1;
  private disposed = false;
  private readonly shutdown = new AbortController();
  private readonly delivered = new Set<string>();
  private firstTurn: ((event: NamingFirstTurnEvent) => void | Promise<void>) | null = null;
  private regeneration: ((event: { conversationId: string; mode: NamingMode }) => void | Promise<void>) | null = null;

  constructor(private readonly deps: NamingHostDeps) {}

  subscribeFirstTurn(listener: (event: NamingFirstTurnEvent) => void | Promise<void>): () => void {
    if (this.disposed) return () => undefined;
    if (this.firstTurn) throw new Error('A naming subscriber is already registered.');
    this.firstTurn = listener;
    return () => { if (this.firstTurn === listener) this.firstTurn = null; };
  }

  subscribeRegeneration(listener: (event: { conversationId: string; mode: NamingMode }) => void | Promise<void>): () => void {
    if (this.disposed) return () => undefined;
    if (this.regeneration) throw new Error('A naming subscriber is already registered.');
    this.regeneration = listener;
    return () => { if (this.regeneration === listener) this.regeneration = null; };
  }

  notifyFirstTurnAccepted(event: NamingFirstTurnEvent): boolean {
    if (this.disposed || !this.firstTurn) return false;
    if (this.delivered.has(event.conversationId)) return true;
    this.delivered.add(event.conversationId);
    const visibleUserText = Array.from(event.visibleUserText).slice(0, 4000).join('');
    this.dispatch(() => this.firstTurn?.({ ...event, visibleUserText }));
    return true;
  }

  requestRegeneration(event: { conversationId: string; mode: NamingMode }): boolean {
    if (this.disposed || !this.regeneration) return false;
    this.dispatch(() => this.regeneration?.({ ...event }));
    return true;
  }

  hasFirstTurnSubscriber(): boolean { return !this.disposed && this.firstTurn !== null; }

  getActiveConversationId(): string | null { return this.disposed ? null : this.deps.getActiveConversationId(); }
  getConversationSnapshot(id: string): NamingConversationSnapshot | null {
    const snapshot = this.disposed ? null : this.deps.getSnapshot(id);
    return snapshot ? Object.freeze({ ...snapshot }) : null;
  }
  listConversationSnapshots(): readonly NamingConversationSnapshot[] {
    return this.disposed ? [] : this.deps.listSnapshots().map(snapshot => Object.freeze({ ...snapshot }));
  }
  getFirstUserText(id: string): Promise<string | null> { return this.disposed ? Promise.resolve(null) : this.deps.getFirstUserText(id); }
  runAuxiliaryTextTask(request: NamingTextTask): Promise<string> {
    return this.disposed ? Promise.reject(new Error('Naming API is unavailable.')) : this.deps.runTextTask(request, this.shutdown.signal);
  }
  setGenerationStatus(id: string, status: NamingStatus): Promise<boolean> {
    return this.disposed ? Promise.resolve(false) : this.deps.setGenerationStatus(id, status);
  }
  updateTitles(id: string, update: NamingTitleUpdate): Promise<NamingTitleResult> {
    return this.disposed ? Promise.resolve({ longTitle: false, shortTitle: false }) : this.deps.updateTitles(id, { ...update });
  }
  dispose(): void {
    this.disposed = true;
    this.firstTurn = null;
    this.regeneration = null;
    this.delivered.clear();
    this.shutdown.abort();
  }
  private dispatch(run: () => void | Promise<void>): void {
    try { void Promise.resolve(run()).catch(() => undefined); } catch { /* Subscriber failures do not fail chat. */ }
  }
}
