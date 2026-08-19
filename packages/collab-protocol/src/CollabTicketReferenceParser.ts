import { COLLAB_LIMITS } from './CollabConstants';
import { maskCollabMarkdownProse } from './CollabMarkdownProse';
import type {
  CollabParsedTicketReference,
  CollabTicketCommitRelationKind,
} from './types';

export type CollabTicketReferenceParseFailureReason =
  | 'description-too-large'
  | 'ticket-number-out-of-range';

export type CollabTicketReferenceParseResult =
  | {
    status: 'ok';
    references: readonly CollabParsedTicketReference[];
  }
  | {
    status: 'invalid';
    reason: CollabTicketReferenceParseFailureReason;
  };

export interface CollabTicketReferenceToken {
  readonly from: number;
  readonly kind: CollabTicketCommitRelationKind;
  readonly ticketNumber: number;
  readonly to: number;
}

export type CollabTicketReferenceScanResult =
  | {
    readonly status: 'ok';
    readonly tokens: readonly CollabTicketReferenceToken[];
  }
  | {
    readonly reason: 'ticket-number-out-of-range';
    readonly status: 'invalid';
  };

const CLOSING_KEYWORD_PATTERN =
  /(?:^|[^A-Za-z])(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)[ \t]*:?[ \t]*$/i;
const TICKET_REFERENCE_PATTERN = /(^|[^#0-9A-Za-z_])#([1-9][0-9]*)(?![#0-9A-Za-z_])/gm;

function relationKindBefore(
  maskedDescription: string,
  referenceOffset: number,
): CollabTicketCommitRelationKind {
  const prefix = maskedDescription.slice(0, referenceOffset);
  return CLOSING_KEYWORD_PATTERN.test(prefix) ? 'resolves' : 'references';
}

export function parseCollabTicketReferences(
  description: string,
): CollabTicketReferenceParseResult {
  if (new TextEncoder().encode(description).byteLength >
    COLLAB_LIMITS.maxRequestDescriptionBytes) {
    return { status: 'invalid', reason: 'description-too-large' };
  }

  const scanned = scanCollabTicketReferences(description);
  if (scanned.status === 'invalid') return scanned;
  const references = new Map<number, CollabTicketCommitRelationKind>();

  for (const token of scanned.tokens) {
    const existing = references.get(token.ticketNumber);
    if (existing !== 'resolves' || token.kind === 'resolves') {
      references.set(token.ticketNumber, token.kind);
    }
  }

  return {
    status: 'ok',
    references: [...references.entries()]
      .sort(([left], [right]) => left - right)
      .map(([ticketNumber, kind]) => ({ ticketNumber, kind })),
  };
}

export function scanCollabTicketReferences(
  description: string,
): CollabTicketReferenceScanResult {
  const prose = maskCollabMarkdownProse(description);
  const tokens: CollabTicketReferenceToken[] = [];

  for (const match of prose.matchAll(TICKET_REFERENCE_PATTERN)) {
    const prefix = match[1] ?? '';
    const numberToken = match[2];
    if (!numberToken || match.index === undefined) continue;
    const ticketNumber = Number(numberToken);
    if (!Number.isSafeInteger(ticketNumber)) {
      return { status: 'invalid', reason: 'ticket-number-out-of-range' };
    }
    const referenceOffset = match.index + prefix.length;
    tokens.push({
      from: referenceOffset,
      kind: relationKindBefore(prose, referenceOffset),
      ticketNumber,
      to: referenceOffset + numberToken.length + 1,
    });
  }

  return { status: 'ok', tokens };
}
