import { mapWithConcurrency } from '../../utils/concurrency';
import { decodeLinkedContentPathFields } from '../path/LinkedContentPath';
import {
  type SessionMetadataListOptions,
  type SessionMetadataScanResult,
} from '../providers/types';
import type { VaultFileAdapter } from '../storage/VaultFileAdapter';
import type {
  ConversationModelRecoverySource,
  SessionMetadata,
} from '../types';
import {
  getDeviceSessionsPath,
  SESSIONS_PATH,
} from './storagePaths';

export {
  SESSIONS_PATH
};

const SAFE_METADATA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SESSION_METADATA_READ_CONCURRENCY = 8;
const SESSION_METADATA_PUBLISH_BATCH_SIZE = 16;
const METADATA_SUFFIX = '.meta.json';

export type SessionMetadataAuthority = 'device' | 'unscoped';
export type SessionMetadataSource = SessionMetadataAuthority;

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
  revalidate(records: readonly SessionMetadataReadResult[]): Promise<SessionMetadataReadResult[]>;
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
  private readonly deviceSessionsPath: string;
  private readonly readVersions = new WeakMap<SessionMetadataReadResult, { mtime: number; size: number }>();

  constructor(
    private readonly adapter: VaultFileAdapter,
    deviceKey: string,
  ) {
    this.deviceSessionsPath = getDeviceSessionsPath(deviceKey);
  }

  getMetadataPath(id: string): string {
    assertValidSessionMetadataId(id);
    return `${this.deviceSessionsPath}/${id}${METADATA_SUFFIX}`;
  }

  getUnscopedMetadataPath(id: string): string {
    assertValidSessionMetadataId(id);
    return `${SESSIONS_PATH}/${id}${METADATA_SUFFIX}`;
  }

  async load(id: string): Promise<SessionMetadataReadResult | null> {
    if (!isValidSessionMetadataId(id)) {
      return null;
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await this.loadOnce(id);
        if (result || attempt === 1) {
          return result;
        }
      } catch {
        if (attempt === 1) {
          return null;
        }
      }
    }
    return null;
  }

  private async loadOnce(id: string): Promise<SessionMetadataReadResult | null> {
    const candidates = [
      { path: this.getMetadataPath(id), source: 'device' },
      { path: this.getUnscopedMetadataPath(id), source: 'unscoped' },
    ] as const;
    for (const { path, source } of candidates) {
      if (await this.adapter.exists(path)) return this.readMetadata(path, id, source);
    }
    return null;
  }

  /** Recheck authority and file versions without parsing unchanged scan records twice. */
  async revalidate(records: readonly SessionMetadataReadResult[]): Promise<SessionMetadataReadResult[]> {
    const checked = await mapWithConcurrency([...records], async record => {
      const version = this.readVersions.get(record);
      if (version) {
        try {
          const id = record.metadata.id;
          const candidates = [
            { path: this.getMetadataPath(id), source: 'device' },
            { path: this.getUnscopedMetadataPath(id), source: 'unscoped' },
          ];
          for (const { path, source } of candidates) {
            if (!await this.adapter.exists(path)) continue;
            if (source !== record.source) break;
            const current = await this.adapter.stat(path);
            if (current && current.mtime === version.mtime && current.size === version.size) {
              return record;
            }
            break;
          }
        } catch {
          // Fall back to the normal read/retry path if version checks are unavailable.
        }
      }
      return this.load(record.metadata.id);
    }, SESSION_METADATA_READ_CONCURRENCY);
    return checked.filter((record): record is SessionMetadataReadResult => record !== null);
  }

  async loadMetadata(id: string): Promise<SessionMetadata | null> {
    return (await this.load(id))?.metadata ?? null;
  }

  async scan(
    options: SessionMetadataReadOptions = {},
  ): Promise<SessionMetadataReadScanResult> {
    const deviceListing = await this.listFiles(this.deviceSessionsPath);
    if (!deviceListing.complete) {
      return {
        records: [],
        complete: false,
        invalidMetadataCount: 0,
      };
    }

    const unscopedListing = await this.listFiles(SESSIONS_PATH);
    if (!unscopedListing.complete) {
      return {
        records: [],
        complete: false,
        invalidMetadataCount: 0,
      };
    }
    let complete = true;
    let invalidMetadataCount = 0;
    const filesById = new Map<string, { path: string; source: SessionMetadataSource }>();
    for (const [listing, source] of [
      [deviceListing, 'device'],
      [unscopedListing, 'unscoped'],
    ] as const) {
      for (const [id, path] of this.indexPathsById(listing.files, METADATA_SUFFIX)) {
        if (!filesById.has(id)) filesById.set(id, { path, source });
      }
    }

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

  private async readMetadata(
    path: string,
    expectedId: string,
    source: SessionMetadataSource,
  ): Promise<SessionMetadataReadResult | null> {
    // Capture before reading so a concurrent write invalidates reuse on the next check.
    let version: { mtime: number; size: number } | null = null;
    try { version = await this.adapter.stat(path); } catch { /* Read normally when stat is unavailable. */ }
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
      externalContextPaths: _externalContextPaths,
      updatedAt: _updatedAt,
      lastResponseAt: _lastResponseAt,
      selectedModel: rawSelectedModel,
      modelRecoverySource: rawModelRecoverySource,
      linkedContentPath: _rawLinkedContentPath,
      currentNote: _rawCurrentNote,
      ...metadataFields
    } = rawMetadata;
    const selectedModel = typeof rawSelectedModel === 'string'
      ? rawSelectedModel
      : undefined;
    const modelRecoverySource = this.parseModelRecoverySource(rawModelRecoverySource);
    const linkedContent = decodeLinkedContentPathFields(rawMetadata);
    const metadata = {
      ...metadataFields,
      ...(selectedModel !== undefined ? { selectedModel } : {}),
      ...(modelRecoverySource ? { modelRecoverySource } : {}),
      ...(linkedContent.path ? { linkedContentPath: linkedContent.path } : {}),
      lastActivityAt,
    } as unknown as SessionMetadata;
    const needsMigration = !Number.isFinite(rawMetadata.lastActivityAt)
      || 'externalContextPaths' in rawMetadata
      || 'updatedAt' in rawMetadata
      || 'lastResponseAt' in rawMetadata
      || linkedContent.needsMigration
      || (rawSelectedModel !== undefined && selectedModel === undefined)
      || (rawModelRecoverySource !== undefined && modelRecoverySource === undefined);
    const record = { metadata, needsMigration, source };
    if (version) this.readVersions.set(record, version);
    return record;
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

  private indexPathsById(
    files: readonly string[],
    suffix: string,
  ): Map<string, string> {
    const pathsById = new Map<string, string>();
    for (const path of files) {
      const id = this.getIdFromPath(path, suffix);
      if (id && isValidSessionMetadataId(id)) {
        pathsById.set(id, path);
      }
    }
    return pathsById;
  }
}
