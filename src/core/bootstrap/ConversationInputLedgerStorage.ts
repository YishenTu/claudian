import { createHash } from 'node:crypto';

import type { VaultFileAdapter } from '../storage/VaultFileAdapter';
import type {
  ExecutionInputContextSnapshot,
  ImageAttachment,
} from '../types';
import { assertValidSessionMetadataId } from './SessionStorage';
import { INPUT_LEDGER_SUFFIX, SESSIONS_PATH } from './storagePaths';

export const CONVERSATION_INPUT_LEDGER_SCHEMA_VERSION = 1 as const;

export type ConversationInputState = 'staged' | 'accepted';

export interface ConversationInputRecord {
  schemaVersion: typeof CONVERSATION_INPUT_LEDGER_SCHEMA_VERSION;
  id: string;
  userTurnOrdinal: number;
  state: ConversationInputState;
  localMessageId?: string;
  providerUserMessageId?: string;
  providerAssistantMessageId?: string;
  timestamp: number;
  rawDisplayText: string;
  canonicalText: string;
  context?: ExecutionInputContextSnapshot;
  images: ImageAttachment[];
  contentDigest: string;
}

export interface ConversationInputLedger {
  schemaVersion: typeof CONVERSATION_INPUT_LEDGER_SCHEMA_VERSION;
  conversationId: string;
  records: ConversationInputRecord[];
}

export type ConversationInputLedgerReadResult =
  | {
      status: 'missing';
    }
  | {
      status: 'loaded';
      ledger: ConversationInputLedger;
    }
  | {
      status: 'unavailable';
      reason: 'malformed' | 'unsupported-version';
    };

export interface ConversationInputDigestSource {
  visibleText: string;
  images: readonly ImageAttachment[];
}

export interface ConversationInputLedgerPersistence {
  load(conversationId: string): Promise<ConversationInputLedgerReadResult>;
  save(
    conversationId: string,
    ledger: ConversationInputLedger,
  ): Promise<void>;
  delete(conversationId: string): Promise<void>;
}

export function computeConversationInputDigest(
  source: ConversationInputDigestSource,
): string {
  const attachmentHashes = source.images.map((image) => ({
    mediaType: image.mediaType,
    sha256: createHash('sha256')
      .update(Buffer.from(image.data, 'base64'))
      .digest('hex'),
  }));
  const serialized = JSON.stringify({
    schemaVersion: CONVERSATION_INPUT_LEDGER_SCHEMA_VERSION,
    visibleText: source.visibleText.replace(/\r\n?/g, '\n').normalize('NFC'),
    attachmentHashes,
  });
  return createHash('sha256').update(serialized).digest('hex');
}

export class ConversationInputLedgerStorage
  implements ConversationInputLedgerPersistence {
  constructor(private readonly adapter: VaultFileAdapter) {}

  getPath(conversationId: string): string {
    assertValidSessionMetadataId(conversationId);
    return `${SESSIONS_PATH}/${conversationId}${INPUT_LEDGER_SUFFIX}`;
  }

  async load(
    conversationId: string,
  ): Promise<ConversationInputLedgerReadResult> {
    const path = this.getPath(conversationId);
    if (!(await this.adapter.exists(path))) {
      return { status: 'missing' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await this.adapter.read(path));
    } catch {
      return { status: 'unavailable', reason: 'malformed' };
    }
    if (
      isRecord(parsed)
      && typeof parsed.schemaVersion === 'number'
      && parsed.schemaVersion !== CONVERSATION_INPUT_LEDGER_SCHEMA_VERSION
    ) {
      return { status: 'unavailable', reason: 'unsupported-version' };
    }
    if (!isConversationInputLedger(parsed, conversationId)) {
      return { status: 'unavailable', reason: 'malformed' };
    }
    return { status: 'loaded', ledger: parsed };
  }

  async save(
    conversationId: string,
    ledger: ConversationInputLedger,
  ): Promise<void> {
    const path = this.getPath(conversationId);
    if (!isConversationInputLedger(ledger, conversationId)) {
      throw new Error(`Invalid conversation input ledger: ${conversationId}`);
    }
    await this.adapter.write(path, JSON.stringify(ledger, null, 2));
  }

  async delete(conversationId: string): Promise<void> {
    await this.adapter.delete(this.getPath(conversationId));
  }
}

function isConversationInputLedger(
  value: unknown,
  conversationId: string,
): value is ConversationInputLedger {
  if (
    !isRecord(value)
    || value.schemaVersion !== CONVERSATION_INPUT_LEDGER_SCHEMA_VERSION
    || value.conversationId !== conversationId
    || !Array.isArray(value.records)
  ) {
    return false;
  }
  return value.records.every(isConversationInputRecord);
}

function isConversationInputRecord(value: unknown): value is ConversationInputRecord {
  return (
    isRecord(value)
    && value.schemaVersion === CONVERSATION_INPUT_LEDGER_SCHEMA_VERSION
    && typeof value.id === 'string'
    && value.id.length > 0
    && Number.isInteger(value.userTurnOrdinal)
    && (value.userTurnOrdinal as number) > 0
    && (value.state === 'staged' || value.state === 'accepted')
    && isOptionalString(value.localMessageId)
    && isOptionalString(value.providerUserMessageId)
    && isOptionalString(value.providerAssistantMessageId)
    && typeof value.timestamp === 'number'
    && Number.isFinite(value.timestamp)
    && typeof value.rawDisplayText === 'string'
    && typeof value.canonicalText === 'string'
    && isOptionalRecord(value.context)
    && Array.isArray(value.images)
    && value.images.every(isImageAttachment)
    && typeof value.contentDigest === 'string'
    && /^[a-f0-9]{64}$/.test(value.contentDigest)
  );
}

function isImageAttachment(value: unknown): value is ImageAttachment {
  return (
    isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(
      String(value.mediaType),
    )
    && typeof value.data === 'string'
    && typeof value.size === 'number'
    && Number.isFinite(value.size)
    && ['file', 'paste', 'drop'].includes(String(value.source))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isOptionalRecord(value: unknown): boolean {
  return value === undefined || isRecord(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}
