import type { ConversationMeta, ConversationOriginKind } from '@/core/types';

const LINEAGE_FOLD_KEY_PREFIX = 'lineage:';

/** Collapse key of the sessions folded under `parentId`; folds start collapsed. */
export function lineageFoldKey(parentId: string): string {
  return `${LINEAGE_FOLD_KEY_PREFIX}${parentId}`;
}

export function isLineageFoldKey(key: string): boolean {
  return key.startsWith(LINEAGE_FOLD_KEY_PREFIX);
}

const LINEAGE_ICONS: Readonly<Record<ConversationOriginKind, string>> = {
  'session-tool': 'bot',
  fork: 'git-branch',
};

export function lineageIcon(kind: ConversationOriginKind): string {
  return LINEAGE_ICONS[kind];
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Counts sessions by how they were started, such as "2 agent sessions · 1 fork". */
export function lineageChildrenLabel(children: readonly ConversationMeta[]): string {
  const started = children.filter(child => child.origin?.kind === 'session-tool').length;
  const forked = children.filter(child => child.origin?.kind === 'fork').length;
  return [
    started > 0 ? plural(started, 'agent session', 'agent sessions') : '',
    forked > 0 ? plural(forked, 'fork', 'forks') : '',
  ].filter(Boolean).join(' · ');
}

export interface SessionLineage {
  /** The session that started this one, while it still exists. */
  readonly parent: { readonly kind: ConversationOriginKind; readonly title: string } | null;
  /** Sessions this one started or that were forked from it, in any scope. */
  readonly children: readonly ConversationMeta[];
}

export function describeLineage(
  conversation: ConversationMeta,
  conversations: readonly ConversationMeta[],
): SessionLineage {
  const { origin } = conversation;
  const parent = origin
    ? conversations.find(candidate => candidate.id === origin.conversationId && candidate.id !== conversation.id)
    : undefined;
  return {
    parent: origin && parent ? { kind: origin.kind, title: parent.title } : null,
    children: conversations.filter(candidate => (
      candidate.origin?.conversationId === conversation.id && candidate.id !== conversation.id
    )),
  };
}
