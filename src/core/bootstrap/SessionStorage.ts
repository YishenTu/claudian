import { mapWithConcurrency } from '../../utils/concurrency';
import { decodeLinkedContentPathFields } from '../path/LinkedContentPath';
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
  ASSIGNMENT_MARKER_SUFFIX,
  DELETION_MARKER_SUFFIX,
  getDeviceSessionsPath,
  isDeviceSettingsKey,
  LEGACY_SESSIONS_PATH,
  SESSIONS_PATH,
} from './storagePaths';

export {
  ASSIGNMENT_MARKER_SUFFIX,
  DELETION_MARKER_SUFFIX,
  LEGACY_SESSIONS_PATH,
  SESSIONS_PATH,
};

const SAFE_METADATA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SESSION_METADATA_READ_CONCURRENCY = 8;
const SESSION_METADATA_PUBLISH_BATCH_SIZE = 16;
const METADATA_SUFFIX = '.meta.json';

export const SESSION_METADATA_ASSIGNMENT_SCHEMA_VERSION = 1 as const;

export interface SessionMetadataAssignment {
  schemaVersion: typeof SESSION_METADATA_ASSIGNMENT_SCHEMA_VERSION;
  conversationId: string;
  deviceKey: string;
}

export type SessionMetadataAssignmentReadResult =
  | { status: 'missing' }
  | { status: 'invalid' }
  | { status: 'assigned'; assignment: SessionMetadataAssignment };

export type SessionMetadataAuthority = 'device' | 'unscoped';
export type SessionMetadataSource = SessionMetadataAuthority | 'legacy';

interface SessionMetadataCandidateState {
  assignment: SessionMetadataAssignmentReadResult;
  deviceDeleted: boolean;
  deviceMetadataPath?: string;
  legacyMetadataPath?: string;
  unscopedDeleted: boolean;
  unscopedMetadataPath?: string;
}

interface SessionMetadataCandidate {
  path: string;
  source: SessionMetadataSource;
}

function selectSessionMetadataCandidate(
  state: SessionMetadataCandidateState,
  deviceKey: string,
): SessionMetadataCandidate | null {
  if (state.assignment.status === 'invalid') return null;
  if (state.assignment.status === 'assigned') {
    if (state.assignment.assignment.deviceKey !== deviceKey) return null;
    if (state.deviceDeleted) return null;
    if (state.deviceMetadataPath) {
      return { path: state.deviceMetadataPath, source: 'device' };
    }
    return state.unscopedMetadataPath
      ? { path: state.unscopedMetadataPath, source: 'device' }
      : null;
  }

  if (state.deviceMetadataPath && !state.deviceDeleted) {
    return { path: state.deviceMetadataPath, source: 'device' };
  }
  if (state.unscopedMetadataPath && !state.unscopedDeleted) {
    return { path: state.unscopedMetadataPath, source: 'unscoped' };
  }
  if (state.legacyMetadataPath && !state.unscopedDeleted) {
    return { path: state.legacyMetadataPath, source: 'legacy' };
  }
  return null;
}

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
  private readonly deviceKey: string;
  private readonly deviceSessionsPath: string;

  constructor(
    private readonly adapter: VaultFileAdapter,
    deviceKey: string,
  ) {
    this.deviceSessionsPath = getDeviceSessionsPath(deviceKey);
    this.deviceKey = deviceKey;
  }

  getDeviceKey(): string {
    return this.deviceKey;
  }

  getMetadataPath(id: string): string {
    assertValidSessionMetadataId(id);
    return `${this.deviceSessionsPath}/${id}${METADATA_SUFFIX}`;
  }

  getUnscopedMetadataPath(id: string): string {
    assertValidSessionMetadataId(id);
    return `${SESSIONS_PATH}/${id}${METADATA_SUFFIX}`;
  }

  getLegacyMetadataPath(id: string): string {
    assertValidSessionMetadataId(id);
    return `${LEGACY_SESSIONS_PATH}/${id}${METADATA_SUFFIX}`;
  }

  getDeviceDeletionMarkerPath(id: string): string {
    assertValidSessionMetadataId(id);
    return `${this.deviceSessionsPath}/${id}${DELETION_MARKER_SUFFIX}`;
  }

  getUnscopedDeletionMarkerPath(id: string): string {
    assertValidSessionMetadataId(id);
    return `${SESSIONS_PATH}/${id}${DELETION_MARKER_SUFFIX}`;
  }

  getAssignmentMarkerPath(id: string): string {
    assertValidSessionMetadataId(id);
    return `${SESSIONS_PATH}/${id}${ASSIGNMENT_MARKER_SUFFIX}`;
  }

  async loadAssignment(
    id: string,
  ): Promise<SessionMetadataAssignmentReadResult> {
    assertValidSessionMetadataId(id);
    const path = this.getAssignmentMarkerPath(id);
    if (!await this.adapter.exists(path)) {
      return { status: 'missing' };
    }
    return this.readAssignment(path, id);
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
    const assignment = await this.loadAssignment(id);
    const deviceMetadataPath = this.getMetadataPath(id);
    const unscopedMetadataPath = this.getUnscopedMetadataPath(id);
    const legacyMetadataPath = this.getLegacyMetadataPath(id);
    const [
      hasDeviceMetadata,
      deviceDeleted,
      hasUnscopedMetadata,
      unscopedDeleted,
      hasLegacyMetadata,
    ] = await Promise.all([
      this.adapter.exists(deviceMetadataPath),
      this.adapter.exists(this.getDeviceDeletionMarkerPath(id)),
      this.adapter.exists(unscopedMetadataPath),
      this.adapter.exists(this.getUnscopedDeletionMarkerPath(id)),
      this.adapter.exists(legacyMetadataPath),
    ]);
    const candidate = selectSessionMetadataCandidate({
      assignment,
      deviceDeleted,
      ...(hasDeviceMetadata ? { deviceMetadataPath } : {}),
      ...(hasLegacyMetadata ? { legacyMetadataPath } : {}),
      unscopedDeleted,
      ...(hasUnscopedMetadata ? { unscopedMetadataPath } : {}),
    }, this.deviceKey);
    if (!candidate) return null;
    return this.readMetadata(candidate.path, id, candidate.source);
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
    const legacyListing = await this.listFiles(LEGACY_SESSIONS_PATH);
    const deviceDeletedIds = new Set(
      this.indexPathsById(deviceListing.files, DELETION_MARKER_SUFFIX).keys(),
    );
    const unscopedDeletedIds = new Set(
      this.indexPathsById(unscopedListing.files, DELETION_MARKER_SUFFIX).keys(),
    );
    let complete = legacyListing.complete;
    let invalidMetadataCount = 0;
    const assignmentPaths = unscopedListing.files.flatMap((path) => {
      const id = this.getIdFromPath(path, ASSIGNMENT_MARKER_SUFFIX);
      return id && isValidSessionMetadataId(id)
        ? [{ id, path }]
        : [];
    });
    const assignmentEntries = await mapWithConcurrency(
      assignmentPaths,
      async ({ id, path }) => {
        try {
          const result = await this.readAssignment(path, id);
          if (result.status === 'invalid') {
            invalidMetadataCount += 1;
          }
          return [id, result] as const;
        } catch {
          complete = false;
          return [id, { status: 'invalid' } as const] as const;
        }
      },
      SESSION_METADATA_READ_CONCURRENCY,
    );
    const assignmentsById = new Map(assignmentEntries);
    const deviceMetadataPaths = this.indexPathsById(
      deviceListing.files,
      METADATA_SUFFIX,
    );
    const unscopedMetadataPaths = this.indexPathsById(
      unscopedListing.files,
      METADATA_SUFFIX,
    );
    const legacyMetadataPaths = this.indexPathsById(
      legacyListing.files,
      METADATA_SUFFIX,
    );
    const filesById = new Map<
      string,
      { path: string; source: SessionMetadataSource }
    >();

    const metadataIds = new Set([
      ...deviceMetadataPaths.keys(),
      ...unscopedMetadataPaths.keys(),
      ...legacyMetadataPaths.keys(),
    ]);
    for (const id of metadataIds) {
      const candidate = selectSessionMetadataCandidate({
        assignment: assignmentsById.get(id) ?? { status: 'missing' },
        deviceDeleted: deviceDeletedIds.has(id),
        deviceMetadataPath: deviceMetadataPaths.get(id),
        legacyMetadataPath: legacyMetadataPaths.get(id),
        unscopedDeleted: unscopedDeletedIds.has(id),
        unscopedMetadataPath: unscopedMetadataPaths.get(id),
      }, this.deviceKey);
      if (candidate) {
        filesById.set(id, candidate);
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
      linkedContentPath: meta.linkedContentPath,
      isPinned: meta.isPinned,
      isArchived: meta.isArchived,
      titleGenerationStatus: meta.titleGenerationStatus,
    }));
    return metas.sort(
      (left, right) =>
        right.lastActivityAt - left.lastActivityAt,
    );
  }

  private async readAssignment(
    path: string,
    expectedId: string,
  ): Promise<SessionMetadataAssignmentReadResult> {
    const content = await this.adapter.read(path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { status: 'invalid' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { status: 'invalid' };
    }
    const assignment = parsed as Record<string, unknown>;
    if (
      assignment.schemaVersion !== SESSION_METADATA_ASSIGNMENT_SCHEMA_VERSION
      || assignment.conversationId !== expectedId
      || !isDeviceSettingsKey(assignment.deviceKey)
    ) {
      return { status: 'invalid' };
    }
    return {
      status: 'assigned',
      assignment: {
        schemaVersion: SESSION_METADATA_ASSIGNMENT_SCHEMA_VERSION,
        conversationId: expectedId,
        deviceKey: assignment.deviceKey,
      },
    };
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
      || 'updatedAt' in rawMetadata
      || 'lastResponseAt' in rawMetadata
      || linkedContent.needsMigration
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
