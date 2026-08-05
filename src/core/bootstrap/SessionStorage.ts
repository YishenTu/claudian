import { mapWithConcurrency } from '../../utils/concurrency';
import {
  DEFAULT_CHAT_PROVIDER_ID,
  type SessionMetadataListOptions,
  type SessionMetadataScanResult,
} from '../providers/types';
import type { VaultFileAdapter } from '../storage/VaultFileAdapter';
import type {
  ConversationMeta,
  ConversationModelRecoverySource,
  SessionMetadata,
} from '../types';
import {
  DELETION_MARKER_SUFFIX,
  LEGACY_SESSIONS_PATH,
  SESSIONS_PATH,
} from './storagePaths';

export {
  DELETION_MARKER_SUFFIX,
  LEGACY_SESSIONS_PATH,
  SESSIONS_PATH,
};

const SAFE_METADATA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SESSION_METADATA_READ_CONCURRENCY = 8;
const SESSION_METADATA_PUBLISH_BATCH_SIZE = 16;
const METADATA_SUFFIX = '.meta.json';

export type SessionMetadataSource = 'current' | 'legacy';

export interface SessionMetadataReadResult {
  metadata: SessionMetadata;
  needsMigration: boolean;
  source: SessionMetadataSource;
}

export interface SessionMetadataReadScanResult {
  records: SessionMetadataReadResult[];
  complete: boolean;
  invalidMetadataCount: number;
}

export interface SessionMetadataReadOptions {
  onBatch?: (records: SessionMetadataReadResult[]) => void;
  batchSize?: number;
}

export interface SessionMetadataReader {
  load(id: string): Promise<SessionMetadataReadResult | null>;
  scan(options?: SessionMetadataReadOptions): Promise<SessionMetadataReadScanResult>;
  loadMetadata(id: string): Promise<SessionMetadata | null>;
  scanMetadata(options?: SessionMetadataListOptions): Promise<SessionMetadataScanResult>;
  listMetadata(options?: SessionMetadataListOptions): Promise<SessionMetadata[]>;
}

export function isValidSessionMetadataId(id: string): boolean {
  return SAFE_METADATA_ID_PATTERN.test(id)
    && id !== '.'
    && id !== '..'
    && !/%(?:2f|5c)/i.test(id);
}

export function assertValidSessionMetadataId(id: string): void {
  if (!isValidSessionMetadataId(id)) {
    throw new Error(`Invalid session metadata id: ${JSON.stringify(id)}`);
  }
}

export class SessionStorage implements SessionMetadataReader {
  constructor(private readonly adapter: VaultFileAdapter) {}

  getMetadataPath(id: string): string {
    assertValidSessionMetadataId(id);
    return `${SESSIONS_PATH}/${id}${METADATA_SUFFIX}`;
  }

  getLegacyMetadataPath(id: string): string {
    assertValidSessionMetadataId(id);
    return `${LEGACY_SESSIONS_PATH}/${id}${METADATA_SUFFIX}`;
  }

  getDeletionMarkerPath(id: string): string {
    assertValidSessionMetadataId(id);
    return `${SESSIONS_PATH}/${id}${DELETION_MARKER_SUFFIX}`;
  }

  async load(id: string): Promise<SessionMetadataReadResult | null> {
    if (!isValidSessionMetadataId(id)) {
      return null;
    }

    try {
      if (await this.adapter.exists(this.getDeletionMarkerPath(id))) {
        return null;
      }
      const currentPath = this.getMetadataPath(id);
      if (await this.adapter.exists(currentPath)) {
        return await this.readMetadata(currentPath, id, 'current');
      }
      const legacyPath = this.getLegacyMetadataPath(id);
      if (await this.adapter.exists(legacyPath)) {
        return await this.readMetadata(legacyPath, id, 'legacy');
      }
    } catch {
      return null;
    }
    return null;
  }

  async loadMetadata(id: string): Promise<SessionMetadata | null> {
    return (await this.load(id))?.metadata ?? null;
  }

  async scan(
    options: SessionMetadataReadOptions = {},
  ): Promise<SessionMetadataReadScanResult> {
    const currentListing = await this.listFiles(SESSIONS_PATH);
    if (!currentListing.complete) {
      return {
        records: [],
        complete: false,
        invalidMetadataCount: 0,
      };
    }

    const legacyListing = await this.listFiles(LEGACY_SESSIONS_PATH);
    const deletedIds = new Set(
      currentListing.files
        .map((path) => this.getIdFromPath(path, DELETION_MARKER_SUFFIX))
        .filter((id): id is string => id !== null && isValidSessionMetadataId(id)),
    );
    const filesById = new Map<
      string,
      { path: string; source: SessionMetadataSource }
    >();

    for (const path of currentListing.files) {
      const id = this.getIdFromPath(path, METADATA_SUFFIX);
      if (id && isValidSessionMetadataId(id) && !deletedIds.has(id)) {
        filesById.set(id, { path, source: 'current' });
      }
    }
    for (const path of legacyListing.files) {
      const id = this.getIdFromPath(path, METADATA_SUFFIX);
      if (
        id
        && isValidSessionMetadataId(id)
        && !deletedIds.has(id)
        && !filesById.has(id)
      ) {
        filesById.set(id, { path, source: 'legacy' });
      }
    }

    let complete = legacyListing.complete;
    let invalidMetadataCount = 0;
    const pendingBatch: SessionMetadataReadResult[] = [];
    const batchSize = Math.max(
      1,
      options.batchSize ?? SESSION_METADATA_PUBLISH_BATCH_SIZE,
    );
    const publish = (record: SessionMetadataReadResult): void => {
      if (!options.onBatch) return;
      pendingBatch.push(record);
      if (pendingBatch.length >= batchSize) {
        options.onBatch(pendingBatch.splice(0, pendingBatch.length));
      }
    };
    const entries = [...filesById.entries()];
    const records = await mapWithConcurrency(
      entries,
      async ([id, entry]) => {
        let record: SessionMetadataReadResult | null;
        try {
          record = await this.readMetadata(entry.path, id, entry.source);
        } catch {
          complete = false;
          return null;
        }
        if (!record) {
          invalidMetadataCount += 1;
          return null;
        }
        publish(record);
        return record;
      },
      SESSION_METADATA_READ_CONCURRENCY,
    );

    if (pendingBatch.length > 0) {
      options.onBatch?.(pendingBatch.splice(0, pendingBatch.length));
    }

    return {
      records: records.filter(
        (record): record is SessionMetadataReadResult => record !== null,
      ),
      complete,
      invalidMetadataCount,
    };
  }

  async scanMetadata(
    options: SessionMetadataListOptions = {},
  ): Promise<SessionMetadataScanResult> {
    const result = await this.scan({
      batchSize: options.batchSize,
      onBatch: options.onBatch
        ? (records) => options.onBatch?.(records.map(({ metadata }) => metadata))
        : undefined,
    });
    return {
      metadata: result.records.map(({ metadata }) => metadata),
      complete: result.complete,
      invalidMetadataCount: result.invalidMetadataCount,
    };
  }

  async listMetadata(
    options: SessionMetadataListOptions = {},
  ): Promise<SessionMetadata[]> {
    return (await this.scanMetadata(options)).metadata;
  }

  async listAllConversations(): Promise<ConversationMeta[]> {
    const nativeMetas = await this.listMetadata();
    const metas: ConversationMeta[] = nativeMetas.map((meta) => ({
      id: meta.id,
      providerId: meta.providerId ?? DEFAULT_CHAT_PROVIDER_ID,
      selectedModel: meta.selectedModel,
      title: meta.title,
      createdAt: meta.createdAt,
      lastActivityAt: meta.lastActivityAt,
      messageCount: 0,
      preview: 'SDK session',
      currentNote: meta.currentNote,
      isPinned: meta.isPinned,
      isArchived: meta.isArchived,
      titleGenerationStatus: meta.titleGenerationStatus,
    }));
    return metas.sort(
      (left, right) =>
        right.lastActivityAt - left.lastActivityAt,
    );
  }

  private async readMetadata(
    path: string,
    expectedId: string,
    source: SessionMetadataSource,
  ): Promise<SessionMetadataReadResult | null> {
    const content = await this.adapter.read(path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const rawMetadata = parsed as Record<string, unknown>;
    if (
      rawMetadata.id !== expectedId
      || typeof rawMetadata.id !== 'string'
      || !isValidSessionMetadataId(rawMetadata.id)
    ) {
      return null;
    }
    const lastActivityAt = this.getFirstFiniteTimestamp(
      rawMetadata.lastActivityAt,
      rawMetadata.lastResponseAt,
      rawMetadata.updatedAt,
      rawMetadata.createdAt,
    ) ?? 0;
    const {
      updatedAt: _updatedAt,
      lastResponseAt: _lastResponseAt,
      selectedModel: rawSelectedModel,
      modelRecoverySource: rawModelRecoverySource,
      ...metadataFields
    } = rawMetadata;
    const selectedModel = typeof rawSelectedModel === 'string'
      ? rawSelectedModel
      : undefined;
    const modelRecoverySource = this.parseModelRecoverySource(rawModelRecoverySource);
    const metadata = {
      ...metadataFields,
      ...(selectedModel !== undefined ? { selectedModel } : {}),
      ...(modelRecoverySource ? { modelRecoverySource } : {}),
      lastActivityAt,
    } as unknown as SessionMetadata;
    const needsMigration = !Number.isFinite(rawMetadata.lastActivityAt)
      || 'updatedAt' in rawMetadata
      || 'lastResponseAt' in rawMetadata
      || (rawSelectedModel !== undefined && selectedModel === undefined)
      || (rawModelRecoverySource !== undefined && modelRecoverySource === undefined);
    return { metadata, needsMigration, source };
  }

  private parseModelRecoverySource(value: unknown): ConversationModelRecoverySource | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const source = value as Record<string, unknown>;
    if (typeof source.sessionId !== 'string' && source.sessionId !== null) return undefined;
    if (
      source.providerState !== undefined
      && (
        !source.providerState
        || typeof source.providerState !== 'object'
        || Array.isArray(source.providerState)
      )
    ) {
      return undefined;
    }
    if (
      source.resumeAtMessageId !== undefined
      && typeof source.resumeAtMessageId !== 'string'
    ) {
      return undefined;
    }
    return {
      sessionId: source.sessionId,
      ...(source.providerState
        ? { providerState: source.providerState as Record<string, unknown> }
        : {}),
      ...(typeof source.resumeAtMessageId === 'string'
        ? { resumeAtMessageId: source.resumeAtMessageId }
        : {}),
    };
  }

  private getFirstFiniteTimestamp(...values: unknown[]): number | undefined {
    return values.find((value): value is number => (
      typeof value === 'number' && Number.isFinite(value)
    ));
  }

  private async listFiles(
    folderPath: string,
  ): Promise<{ files: string[]; complete: boolean }> {
    try {
      return {
        files: await this.adapter.listFiles(folderPath),
        complete: true,
      };
    } catch {
      return { files: [], complete: false };
    }
  }

  private getIdFromPath(path: string, suffix: string): string | null {
    const fileName = path.split('/').at(-1) ?? path;
    return fileName.endsWith(suffix)
      ? fileName.slice(0, -suffix.length)
      : null;
  }
}
