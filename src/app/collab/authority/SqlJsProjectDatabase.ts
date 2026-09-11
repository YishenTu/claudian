import {
  lstat,
  realpath,
} from 'node:fs/promises';

import type {
  BindParams,
  Database,
  SqlJsStatic,
  SqlValue,
} from 'sql.js';

import {
  applyAuthorityMigrations,
  assertAuthorityDatabaseIntegrity,
} from '@/app/collab/authority/AuthoritySchema';
import { assertAuthorityTransactionIntegrity, beginAuthorityTransaction } from '@/app/collab/authority/AuthorityTransactionIntegrity';
import {
  NodeSqlJsSnapshotStore,
  type SqlJsSnapshotKind,
  type SqlJsSnapshotStore,
} from '@/app/collab/authority/SqlJsSnapshotStore';
import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export type AuthoritySqlValue = SqlValue;
export type AuthoritySqlRow = Readonly<Record<string, AuthoritySqlValue>>;

export interface AuthorityDatabaseConnection {
  run(sql: string, params?: BindParams): number;
  get(sql: string, params?: BindParams): AuthoritySqlRow | null;
  all(sql: string, params?: BindParams): readonly AuthoritySqlRow[];
}

export interface SqlJsProjectDatabaseOptions {
  readonly resourceAdmission?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly loadSqlJs?: () => Promise<SqlJsStatic>;
  readonly snapshotStore?: SqlJsSnapshotStore;
}

export interface SqlJsProjectDatabaseOpenResult {
  readonly generation: number;
  readonly migrated: boolean;
  readonly source: SqlJsSnapshotKind | 'new';
}

export interface SqlJsMutationResult<T> {
  readonly generation: number;
  readonly value: T;
}

export interface SqlJsProjectDatabaseSubscription {
  dispose(): void;
}

interface PendingMutation {
  readonly apply: (database: Database) => { readonly generation: number; readonly complete: () => void };
  readonly reject: (error: unknown) => void;
}

const MAX_MUTATIONS_PER_SNAPSHOT = 16;

interface ValidCandidate {
  readonly database: Database;
  readonly generation: number;
  readonly kind: SqlJsSnapshotKind;
  readonly migrated: boolean;
}

const CANDIDATE_PRIORITY: Readonly<Record<SqlJsSnapshotKind, number>> = {
  primary: 3,
  temporary: 2,
  backup: 1,
};

function authorityError(
  code:
    | 'authority-integrity-error'
    | 'database-corrupt'
    | 'durable-progress-recovery-required'
    | 'not-initialized'
    | 'operation-failed'
    | 'schema-version-unsupported',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'database-corrupt'
      ? ['open-diagnostics', 'export-repair-data']
      : code === 'durable-progress-recovery-required'
        ? ['resume', 'open-diagnostics']
        : ['open-diagnostics'],
    safeContext: { reason },
  });
}

async function loadDefaultSqlJs(): Promise<SqlJsStatic> {
  const [sqlJsModule, wasmModule] = await Promise.all([
    import('sql.js'),
    import('sql.js/dist/sql-wasm.wasm'),
  ]);
  return sqlJsModule.default({
    wasmBinary: Uint8Array.from(wasmModule.default).buffer,
  });
}

class SqlJsConnection implements AuthorityDatabaseConnection {
  constructor(private readonly database: Database) {}

  run(sql: string, params?: BindParams): number {
    this.database.run(sql, params);
    return this.database.getRowsModified();
  }

  get(sql: string, params?: BindParams): AuthoritySqlRow | null {
    return this.all(sql, params)[0] ?? null;
  }

  all(sql: string, params?: BindParams): readonly AuthoritySqlRow[] {
    const statement = this.database.prepare(sql);
    try {
      if (params !== undefined) statement.bind(params);
      const rows: AuthoritySqlRow[] = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return rows;
    } finally {
      statement.free();
    }
  }
}

export class SqlJsProjectDatabase {
  private blockedError: CollabError | null = null;
  private closed = false;
  private database: Database | null = null;
  private generationValue = 0;
  private hasValidPrimary = false;
  private readonly loadSqlJs: () => Promise<SqlJsStatic>;
  private readonly mutationListeners = new Set<(generation: number) => void>();
  private pendingMutationBatch: PendingMutation[] | null = null;
  private openResult: SqlJsProjectDatabaseOpenResult | null = null;
  private readonly queue = new SerialTaskQueue();
  private readonly resourceAdmission: <T>(operation: () => Promise<T>) => Promise<T>;
  private readonly snapshotStore: SqlJsSnapshotStore;

  constructor(
    private readonly authorityDirectory: string,
    options: SqlJsProjectDatabaseOptions = {},
  ) {
    this.resourceAdmission = options.resourceAdmission ?? (operation => operation());
    this.loadSqlJs = options.loadSqlJs ?? loadDefaultSqlJs;
    this.snapshotStore = options.snapshotStore
      ?? new NodeSqlJsSnapshotStore(authorityDirectory);
  }

  async inspectPersisted(reader: (connection: AuthorityDatabaseConnection) => void): Promise<boolean> {
    await this.#assertAuthorityDirectory();
    const sql = await this.loadSqlJs();
    let inspected = false;
    for (const kind of ['primary', 'temporary', 'backup'] as const) {
      const bytes = await this.snapshotStore.readCandidate(kind);
      if (bytes === null) continue;
      let database: Database | null = null;
      try {
        database = new sql.Database(bytes);
        database.run('PRAGMA query_only = ON');
        reader(new SqlJsConnection(database));
        inspected = true;
      } finally {
        database?.close();
      }
    }
    return inspected;
  }

  get generation(): number {
    return this.generationValue;
  }

  open(): Promise<SqlJsProjectDatabaseOpenResult> {
    this.pendingMutationBatch = null;
    return this.queue.run(() => this.resourceAdmission(() => this.#openUnlocked()));
  }

  read<T>(reader: (connection: AuthorityDatabaseConnection) => T): Promise<T> {
    this.pendingMutationBatch = null;
    return this.queue.run(() => this.resourceAdmission(async () => {
      const database = this.#requireDatabase();
      return reader(new SqlJsConnection(database));
    }));
  }

  exportSnapshot(): Promise<Uint8Array> {
    this.pendingMutationBatch = null;
    return this.queue.run(() => this.resourceAdmission(async () => Uint8Array.from(this.#requireDatabase().export())));
  }

  mutate<T>(
    mutation: (connection: AuthorityDatabaseConnection) => T,
  ): Promise<SqlJsMutationResult<T>> {
    return new Promise((resolve, reject) => {
      let batch = this.pendingMutationBatch;
      if (batch === null || batch.length >= MAX_MUTATIONS_PER_SNAPSHOT) {
        batch = [];
        this.pendingMutationBatch = batch;
        const scheduled = batch;
        void this.queue.run(() => this.resourceAdmission(() => this.#commitMutationBatch(scheduled))).catch(error => {
          for (const pending of scheduled) pending.reject(error);
        });
      }
      batch.push({
        apply: database => {
          const result = this.#applyMutation(database, mutation);
          return { generation: result.generation, complete: () => resolve(result) };
        },
        reject,
      });
    });
  }

  async #commitMutationBatch(batch: readonly PendingMutation[]): Promise<void> {
    if (this.pendingMutationBatch === batch) this.pendingMutationBatch = null;
    const database = this.#requireDatabase();
    const committed: Array<{ readonly generation: number; readonly complete: () => void }> = [];
    for (const pending of batch) {
      try {
        this.#requireDatabase();
        committed.push(pending.apply(database));
      } catch (error) {
        pending.reject(error);
      }
    }
    if (committed.length === 0) return;
    try {
      this.#requireDatabase();
      await this.#persistSnapshot(database.export(), this.hasValidPrimary);
    } catch {
      throw this.#blockForRecovery();
    }
    this.hasValidPrimary = true;
    this.generationValue = committed[committed.length - 1].generation;
    for (const result of committed) {
      this.#notifyMutationListeners(result.generation);
      result.complete();
    }
  }

  #applyMutation<T>(
    database: Database,
    mutation: (connection: AuthorityDatabaseConnection) => T,
  ): SqlJsMutationResult<T> {
    beginAuthorityTransaction(database);
    try {
      const value = mutation(new SqlJsConnection(database));
      if (value instanceof Promise) {
        throw authorityError('operation-failed', 'authority-mutation-must-be-synchronous');
      }
      database.run(`
        UPDATE project
        SET snapshot_generation = snapshot_generation + 1
        WHERE singleton = 1
      `);
      if (database.getRowsModified() !== 1) {
        throw authorityError('authority-integrity-error', 'authority-project-row-missing');
      }
      const generation = assertAuthorityTransactionIntegrity(database);
      database.run('COMMIT');
      return { generation, value };
    } catch (error) {
      try {
        database.run('ROLLBACK');
      } catch {
        throw this.#blockForRecovery();
      }
      if (error instanceof CollabError) throw error;
      throw authorityError('authority-integrity-error', 'authority-transaction-failed');
    }
  }

  close(): Promise<void> {
    this.pendingMutationBatch = null;
    return this.queue.run(async () => {
      this.mutationListeners.clear();
      this.database?.close();
      this.database = null;
      this.closed = true;
    });
  }

  subscribe(listener: (generation: number) => void): SqlJsProjectDatabaseSubscription {
    this.#requireDatabase();
    this.mutationListeners.add(listener);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.mutationListeners.delete(listener);
      },
    };
  }

  async #openUnlocked(): Promise<SqlJsProjectDatabaseOpenResult> {
    if (this.blockedError) throw this.blockedError;
    if (this.closed) throw authorityError('not-initialized', 'authority-database-closed');
    if (this.database && this.openResult) return this.openResult;
    await this.#assertAuthorityDirectory();
    const SQL = await this.loadSqlJs().catch(() => {
      throw authorityError('operation-failed', 'sql-js-initialize-failed');
    });
    const kinds: readonly SqlJsSnapshotKind[] = ['primary', 'temporary', 'backup'];
    let foundSnapshot = false;
    let selected: ValidCandidate | null = null;
    let hasValidPrimary = false;
    let unsupportedVersion = false;
    for (const kind of kinds) {
      let candidate: ValidCandidate | 'absent' | 'invalid' | 'unsupported';
      try {
        candidate = await this.#inspectCandidate(SQL, kind);
      } catch (error) {
        selected?.database.close();
        throw error;
      }
      if (candidate === 'absent') continue;
      foundSnapshot = true;
      if (candidate === 'unsupported') {
        unsupportedVersion = true;
        continue;
      }
      if (candidate === 'invalid') continue;
      if (kind === 'primary') hasValidPrimary = true;
      if (
        selected === null
        || candidate.generation > selected.generation
        || (candidate.generation === selected.generation
          && CANDIDATE_PRIORITY[candidate.kind] > CANDIDATE_PRIORITY[selected.kind])
      ) {
        selected?.database.close();
        selected = candidate;
      } else {
        candidate.database.close();
      }
    }

    if (unsupportedVersion) {
      selected?.database.close();
      throw authorityError('schema-version-unsupported', 'authority-schema-newer');
    }

    if (selected === null) {
      if (foundSnapshot) {
        throw authorityError('database-corrupt', 'no-valid-authority-snapshot');
      }
      const database = new SQL.Database();
      try {
        applyAuthorityMigrations(database);
        database.run('PRAGMA foreign_keys = ON');
      } catch {
        database.close();
        throw authorityError('operation-failed', 'authority-schema-initialize-failed');
      }
      this.database = database;
      this.generationValue = 0;
      this.openResult = { generation: 0, migrated: false, source: 'new' };
      return this.openResult;
    }

    this.database = selected.database;
    this.generationValue = selected.generation;
    this.hasValidPrimary = hasValidPrimary;

    try {
      if (selected.migrated) {
        selected.database.run('BEGIN IMMEDIATE');
        selected.database.run(`
          UPDATE project
          SET snapshot_generation = snapshot_generation + 1
          WHERE singleton = 1
        `);
        const generation = assertAuthorityDatabaseIntegrity(selected.database, {
          full: false,
          requireProject: true,
        });
        selected.database.run('COMMIT');
        await this.#persistSnapshot(selected.database.export(), this.hasValidPrimary);
        this.generationValue = generation;
        this.hasValidPrimary = true;
      } else if (selected.kind !== 'primary') {
        await this.#persistSnapshot(selected.database.export(), this.hasValidPrimary);
        this.hasValidPrimary = true;
      }
    } catch {
      throw this.#blockForRecovery();
    }

    this.openResult = {
      generation: this.generationValue,
      migrated: selected.migrated,
      source: selected.kind,
    };
    return this.openResult;
  }

  async #inspectCandidate(
    sqlJs: SqlJsStatic,
    kind: SqlJsSnapshotKind,
  ): Promise<ValidCandidate | 'absent' | 'invalid' | 'unsupported'> {
    // Keep raw bytes out of the selection loop's async frame so a discarded
    // image can be collected before the next candidate is allocated.
    const bytes = await this.snapshotStore.readCandidate(kind);
    if (bytes === null) return 'absent';
    try {
      return this.#validateCandidate(sqlJs, kind, bytes);
    } catch (error) {
      return error instanceof CollabError && error.code === 'schema-version-unsupported'
        ? 'unsupported'
        : 'invalid';
    }
  }

  #validateCandidate(
    sqlJs: SqlJsStatic,
    kind: SqlJsSnapshotKind,
    bytes: Uint8Array,
  ): ValidCandidate {
    if (
      bytes.byteLength < 16
      || Buffer.from(bytes.subarray(0, 16)).toString('binary') !== 'SQLite format 3\u0000'
    ) {
      throw authorityError('database-corrupt', 'authority-header-invalid');
    }
    let database: Database | null = null;
    try {
      database = new sqlJs.Database(bytes);
      database.run('PRAGMA foreign_keys = ON');
      let migrated: boolean;
      try {
        migrated = applyAuthorityMigrations(database);
      } catch (error) {
        if (error instanceof RangeError) {
          throw authorityError('schema-version-unsupported', 'authority-schema-newer');
        }
        throw error;
      }
      const generation = assertAuthorityDatabaseIntegrity(database, {
        full: true,
        requireProject: true,
      });
      return { database, generation, kind, migrated };
    } catch (error) {
      database?.close();
      throw error;
    }
  }

  async #persistSnapshot(bytes: Uint8Array, rotatePrimary: boolean): Promise<void> {
    await this.snapshotStore.writeTemporary(bytes);
    if (rotatePrimary) {
      await this.snapshotStore.removeBackup();
      await this.snapshotStore.rotatePrimaryToBackup();
    } else {
      await this.snapshotStore.removePrimary();
    }
    await this.snapshotStore.promoteTemporary();
    await this.snapshotStore.syncDirectory();
  }

  #requireDatabase(): Database {
    if (this.blockedError) throw this.blockedError;
    if (!this.database || this.closed) {
      throw authorityError('not-initialized', 'authority-database-not-open');
    }
    return this.database;
  }

  #notifyMutationListeners(generation: number): void {
    for (const listener of [...this.mutationListeners]) {
      try {
        listener(generation);
      } catch {
        // A committed durable mutation cannot be rolled back by an observer.
      }
    }
  }

  #blockForRecovery(): CollabError {
    this.database?.close();
    this.database = null;
    this.blockedError ??= authorityError(
      'durable-progress-recovery-required',
      'authority-snapshot-interrupted',
    );
    return this.blockedError;
  }

  async #assertAuthorityDirectory(): Promise<void> {
    const directoryStat = await lstat(this.authorityDirectory).catch(() => null);
    if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) {
      throw authorityError('database-corrupt', 'authority-directory-invalid');
    }
    if (!await realpath(this.authorityDirectory).catch(() => null)) {
      throw authorityError('database-corrupt', 'authority-directory-unavailable');
    }
  }
}
