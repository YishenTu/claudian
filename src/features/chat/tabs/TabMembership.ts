import type { AppTabManagerState } from '@/core/bootstrap/tabManagerState';
import type { ProviderId } from '@/core/providers/types';
import type { TabId } from '@/features/chat/tabs/ChatTab';
import type { BlankTabSelection, TabIdentity } from '@/features/chat/tabs/TabIdentity';
import type { AssembledTabRuntime, TabMembershipView } from '@/features/chat/tabs/types';

/** A restored tab not yet assembled, or an assembled runtime. */
export type TabMember =
  | { readonly kind: 'restored'; readonly identity: TabIdentity }
  | { readonly kind: 'assembled'; readonly runtime: AssembledTabRuntime };

/** The member's identity: the restored record itself, or the runtime's session-backed view. */
export function memberIdentity(member: TabMember): Readonly<TabIdentity> {
  return member.kind === 'restored' ? member.identity : member.runtime;
}

interface TabRecord {
  /** Null while the ID is only reserved for an assembly. */
  member: TabMember | null;
  /** Admission committed: the tab persists and may own the committed activation. */
  admitted: boolean;
  /** A close was admitted and has not finished releasing the tab. */
  closeClaimed: boolean;
  /** An assembly holds this ID; it cannot be reused until the assembly settles. */
  reserved: boolean;
  /** Order of the latest committed activation since admission; null when none. */
  activation: number | null;
}

/**
 * One record per tab: membership, admission, close claims, assembly reservations, and committed
 * activation history, plus the optimistic active tab. Only TabManager and the owners it composes
 * (activation, close policy) mutate it; collaborators read it through `TabMembershipView`.
 */
export class TabMembership implements TabMembershipView {
  readonly #records = new Map<TabId, TabRecord>();
  #activeTabId: TabId | null = null;
  #activationClock = 0;
  #destroyed = false;
  #identitiesSealed = false;

  // ============================================
  // Reads
  // ============================================

  isDestroyed(): boolean {
    return this.#destroyed;
  }

  /** The optimistic active tab; committed activation history is recorded separately. */
  getActiveTabId(): TabId | null {
    return this.#activeTabId;
  }

  getMember(tabId: TabId): TabMember | null {
    return this.#records.get(tabId)?.member ?? null;
  }

  getIdentity(tabId: TabId): Readonly<TabIdentity> | null {
    const member = this.getMember(tabId);
    return member ? memberIdentity(member) : null;
  }

  getTab(tabId: TabId): AssembledTabRuntime | null {
    const member = this.getMember(tabId);
    return member?.kind === 'assembled' ? member.runtime : null;
  }

  getAllTabs(): AssembledTabRuntime[] {
    return this.#members().flatMap(member => (member.kind === 'assembled' ? [member.runtime] : []));
  }

  getTabIdentities(): readonly Readonly<TabIdentity>[] {
    return this.#members().map(memberIdentity);
  }

  get size(): number {
    return this.#members().length;
  }

  /** Owned or reserved: the ID cannot be taken by another tab. */
  holds(tabId: TabId): boolean {
    return this.#records.has(tabId);
  }

  isTabAlive(tab: Readonly<TabIdentity>): boolean {
    return !this.#destroyed && this.isAvailableToAdmittedClose(tab);
  }

  isTabStateMutable(tab: Readonly<TabIdentity>): boolean {
    return !this.#destroyed && this.isOwned(tab);
  }

  isCloseClaimed(tabId: TabId): boolean {
    return this.#records.get(tabId)?.closeClaimed ?? false;
  }

  /** Owned and not closing, even while a close is claimed or the manager shuts down. */
  isOwned(tab: Readonly<TabIdentity>): boolean {
    return tab.lifecycleState !== 'closing' && this.getIdentity(tab.id) === tab;
  }

  /** Owned and not claimed by a close; ignores shutdown so a close admitted before it can finish. */
  isAvailableToAdmittedClose(tab: Readonly<TabIdentity>): boolean {
    return !this.isCloseClaimed(tab.id) && this.isOwned(tab);
  }

  hasAdmittedProvider(providerId: ProviderId): boolean {
    return [...this.#records.values()].some(record => {
      const identity = record.member && memberIdentity(record.member);
      return record.admitted && identity?.providerId === providerId && identity.lifecycleState !== 'closing';
    });
  }

  // ============================================
  // Membership transitions
  // ============================================

  markDestroyed(): void {
    this.#destroyed = true;
  }

  setActiveTabId(tabId: TabId | null): void {
    this.#activeTabId = tabId;
  }

  /** Holds `tabId` for an assembly: a new ID, or the restored tab being assembled. */
  reserve(tabId: TabId): void {
    const record = this.#records.get(tabId);
    if (record) record.reserved = true;
    else this.#records.set(tabId, { member: null, admitted: false, closeClaimed: false, reserved: true, activation: null });
  }

  endReservation(tabId: TabId): void {
    const record = this.#records.get(tabId);
    if (!record) return;
    record.reserved = false;
    if (!record.member) this.#records.delete(tabId);
  }

  /** Adds an admitted restored tab, appended to membership order. */
  addRestored(identity: TabIdentity): void {
    this.#records.set(identity.id, {
      member: { kind: 'restored', identity }, admitted: true, closeClaimed: false, reserved: false, activation: null,
    });
  }

  /** Unloads an assembled tab to its restored identity, keeping position and activation history. */
  unload(identity: TabIdentity): void {
    const record = this.#records.get(identity.id);
    if (record?.member?.kind === 'assembled') record.member = { kind: 'restored', identity };
  }

  /** Replaces a restored tab's identity in place, invalidating assemblies of the old one. */
  replaceRestored(identity: TabIdentity): void {
    const record = this.#records.get(identity.id);
    if (record?.member?.kind === 'restored') record.member = { kind: 'restored', identity };
  }

  /**
   * Installs an assembled runtime on its reserved ID. A restored tab keeps its position; a new
   * tab joins membership order when its assembly completes.
   */
  install(runtime: AssembledTabRuntime): void {
    const record = this.#records.get(runtime.id);
    if (!record) throw new Error(`Tab ID is not reserved: ${runtime.id}`);
    if (!record.member) {
      this.#records.delete(runtime.id);
      this.#records.set(runtime.id, record);
    }
    record.member = { kind: 'assembled', runtime };
  }

  admit(tabId: TabId): void {
    const record = this.#records.get(tabId);
    if (record) record.admitted = true;
  }

  claimClose(tabId: TabId): void {
    const record = this.#records.get(tabId);
    if (record) record.closeClaimed = true;
  }

  releaseCloseClaim(tabId: TabId): void {
    const record = this.#records.get(tabId);
    if (record) record.closeClaimed = false;
  }

  /** The irreversible start of teardown: the tab leaves persistence and activation history. */
  beginClose(tabId: TabId): void {
    const record = this.#records.get(tabId);
    if (!record?.member) return;
    if (record.member.kind === 'assembled') record.member.runtime.session.beginClose();
    else record.member.identity.lifecycleState = 'closing';
    record.admitted = false;
    record.activation = null;
  }

  /** Drops the tab; a reserved ID stays held until its assembly settles. */
  remove(tabId: TabId): void {
    const record = this.#records.get(tabId);
    if (!record) return;
    if (!record.reserved) {
      this.#records.delete(tabId);
      return;
    }
    record.member = null;
    record.admitted = false;
    record.activation = null;
  }

  /** Applies a blank-draft reselection; sealed identities no longer change. */
  selectDraft(tabId: TabId, selection: BlankTabSelection): void {
    const member = this.getMember(tabId);
    if (member?.kind === 'assembled') {
      member.runtime.session.selectDraft(selection.providerId, selection.draftModel);
    } else if (member && !this.#identitiesSealed) {
      member.identity.providerId = selection.providerId;
      member.identity.draftModel = selection.draftModel;
    }
  }

  /** Returns whether the label changed; null clears it. */
  setLabel(tabId: TabId, label: string | null): boolean {
    const member = this.getMember(tabId);
    if (!member) return false;
    if (member.kind === 'assembled') return member.runtime.session.setLabel(label);
    if ((member.identity.label ?? null) === label) return false;
    if (label === null) delete member.identity.label;
    else member.identity.label = label;
    return true;
  }

  /** Seals every identity for the final shutdown snapshot. */
  sealIdentities(): void {
    this.#identitiesSealed = true;
    for (const tab of this.getAllTabs()) tab.session.sealIdentity();
  }

  clear(): void {
    this.#records.clear();
    this.#activeTabId = null;
  }

  // ============================================
  // Committed activation history
  // ============================================

  /** Records a committed activation of an admitted tab, making it the most recent. */
  recordCommittedActivation(tabId: TabId): void {
    const record = this.#records.get(tabId);
    if (record?.admitted) record.activation = ++this.#activationClock;
  }

  /** The most recently activated retained tab, so a shown preview never displaces it. */
  getRetainedActiveTabId(excludedTabId: TabId | null = null, requireLive = false): TabId | null {
    let latest: { tabId: TabId; activation: number } | null = null;
    for (const [tabId, record] of this.#records) {
      if (
        tabId === excludedTabId
        || record.activation === null
        || !this.#isRetained(record)
        || (requireLive && !this.isTabAlive(memberIdentity(record.member!)))
      ) continue;
      if (!latest || record.activation > latest.activation) latest = { tabId, activation: record.activation };
    }
    return latest?.tabId ?? null;
  }

  /**
   * Every retained tab identity without runtime lifecycle state. A preview persists only while
   * active, so the wide viewer's selection (a session or a new draft) survives reload.
   */
  getPersistedState(): AppTabManagerState {
    const activePreviewId = this.#activePreviewId();
    const openTabs: AppTabManagerState['openTabs'] = [];
    for (const [tabId, record] of this.#records) {
      const isActivePreview = tabId === activePreviewId;
      if (!isActivePreview && !this.#isRetained(record)) continue;
      const tab = memberIdentity(record.member!);
      openTabs.push({
        tabId: tab.id,
        conversationId: tab.conversationId,
        ...(tab.conversationId === null && tab.draftModel
          ? { draftModel: tab.draftModel, providerId: tab.providerId }
          : {}),
        ...(tab.label ? { label: tab.label } : {}),
        ...(isActivePreview ? { preview: true as const } : {}),
      });
    }
    return { openTabs, activeTabId: activePreviewId ?? this.getRetainedActiveTabId() };
  }

  /** The most recently activated admitted tab, when it is a provisional preview. */
  #activePreviewId(): TabId | null {
    let latest: { tabId: TabId; record: TabRecord } | null = null;
    for (const [tabId, record] of this.#records) {
      if (!record.admitted || !record.member || record.activation === null) continue;
      if (!latest || record.activation > latest.record.activation!) latest = { tabId, record };
    }
    if (!latest) return null;
    const identity = memberIdentity(latest.record.member!);
    return identity.lifecycleState === 'provisional' ? latest.tabId : null;
  }

  #isRetained(record: TabRecord): boolean {
    return record.admitted && !!record.member && memberIdentity(record.member).lifecycleState !== 'provisional';
  }

  #members(): TabMember[] {
    return [...this.#records.values()].flatMap(record => (record.member ? [record.member] : []));
  }
}
