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
  private openResult: SqlJsProjectDatabaseOpenResult | null = null;
  private readonly queue = new SerialTaskQueue();
  private readonly snapshotStore: SqlJsSnapshotStore;

  constructor(
    private readonly authorityDirectory: string,
    options: SqlJsProjectDatabaseOptions = {},
  ) {
    this.loadSqlJs = options.loadSqlJs ?? loadDefaultSqlJs;
    this.snapshotStore = options.snapshotStore
      ?? new NodeSqlJsSnapshotStore(authorityDirectory);
  }

  get generation(): number {
    return this.generationValue;
  }

  open(): Promise<SqlJsProjectDatabaseOpenResult> {
    return this.queue.run(() => this.openUnlocked());
  }

  read<T>(reader: (connection: AuthorityDatabaseConnection) => T): Promise<T> {
    return this.queue.run(async () => {
      const database = this.requireDatabase();
      return reader(new SqlJsConnection(database));
    });
  }

  exportSnapshot(): Promise<Uint8Array> {
    return this.queue.run(async () => Uint8Array.from(this.requireDatabase().export()));
  }

  mutate<T>(
    mutation: (connection: AuthorityDatabaseConnection) => T,
  ): Promise<SqlJsMutationResult<T>> {
    return this.queue.run(async () => {
      const database = this.requireDatabase();
      database.run('BEGIN IMMEDIATE');
      let transactionCommitted = false;
      let value: T;
      try {
        value = mutation(new SqlJsConnection(database));
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
        const generation = assertAuthorityDatabaseIntegrity(database, {
          full: false,
          requireProject: true,
        });
        database.run('COMMIT');
        transactionCommitted = true;
        const bytes = database.export();
        await this.persistSnapshot(bytes, this.hasValidPrimary);
        this.generationValue = generation;
        this.hasValidPrimary = true;
        this.notifyMutationListeners(generation);
        return { generation, value };
      } catch (error) {
        if (!transactionCommitted) {
          try {
            database.run('ROLLBACK');
          } catch {
            throw this.blockForRecovery();
          }
        }
        if (transactionCommitted) throw this.blockForRecovery();
        if (error instanceof CollabError) throw error;
        throw authorityError('authority-integrity-error', 'authority-transaction-failed');
      }
    });
  }

  close(): Promise<void> {
    return this.queue.run(async () => {
      this.mutationListeners.clear();
      this.database?.close();
      this.database = null;
      this.closed = true;
    });
  }

  subscribe(listener: (generation: number) => void): SqlJsProjectDatabaseSubscription {
    this.requireDatabase();
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

  private async openUnlocked(): Promise<SqlJsProjectDatabaseOpenResult> {
    if (this.blockedError) throw this.blockedError;
    if (this.closed) throw authorityError('not-initialized', 'authority-database-closed');
    if (this.database && this.openResult) return this.openResult;
    await this.assertAuthorityDirectory();
    const SQL = await this.loadSqlJs().catch(() => {
      throw authorityError('operation-failed', 'sql-js-initialize-failed');
    });
    const kinds: readonly SqlJsSnapshotKind[] = ['primary', 'temporary', 'backup'];
    const rawCandidates = new Map<SqlJsSnapshotKind, Uint8Array>();
    const validCandidates: ValidCandidate[] = [];
    let unsupportedVersion = false;
    for (const kind of kinds) {
      let bytes: Uint8Array | null;
      try {
        bytes = await this.snapshotStore.readCandidate(kind);
      } catch (error) {
        for (const candidate of validCandidates) candidate.database.close();
        throw error;
      }
      if (bytes === null) continue;
      rawCandidates.set(kind, bytes);
      try {
        validCandidates.push(this.validateCandidate(SQL, kind, bytes));
      } catch (error) {
        if (
          error instanceof CollabError
          && error.code === 'schema-version-unsupported'
        ) {
          unsupportedVersion = true;
        }
      }
    }

    if (unsupportedVersion) {
      for (const candidate of validCandidates) candidate.database.close();
      throw authorityError('schema-version-unsupported', 'authority-schema-newer');
    }

    if (validCandidates.length === 0) {
      if (rawCandidates.size > 0) {
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

    validCandidates.sort((left, right) => (
      right.generation - left.generation
      || CANDIDATE_PRIORITY[right.kind] - CANDIDATE_PRIORITY[left.kind]
    ));
    const selected = validCandidates[0];
    for (const candidate of validCandidates.slice(1)) candidate.database.close();
    this.database = selected.database;
    this.generationValue = selected.generation;
    this.hasValidPrimary = validCandidates.some(candidate => candidate.kind === 'primary');

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
        await this.persistSnapshot(selected.database.export(), this.hasValidPrimary);
        this.generationValue = generation;
        this.hasValidPrimary = true;
      } else if (selected.kind !== 'primary') {
        await this.persistSnapshot(selected.database.export(), this.hasValidPrimary);
        this.hasValidPrimary = true;
      }
    } catch {
      throw this.blockForRecovery();
    }

    this.openResult = {
      generation: this.generationValue,
      migrated: selected.migrated,
      source: selected.kind,
    };
    return this.openResult;
  }

  private validateCandidate(
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

  private async persistSnapshot(bytes: Uint8Array, rotatePrimary: boolean): Promise<void> {
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

  private requireDatabase(): Database {
    if (this.blockedError) throw this.blockedError;
    if (!this.database || this.closed) {
      throw authorityError('not-initialized', 'authority-database-not-open');
    }
    return this.database;
  }

  private notifyMutationListeners(generation: number): void {
    for (const listener of [...this.mutationListeners]) {
      try {
        listener(generation);
      } catch {
        // A committed durable mutation cannot be rolled back by an observer.
      }
    }
  }

  private blockForRecovery(): CollabError {
    this.database?.close();
    this.database = null;
    this.blockedError ??= authorityError(
      'durable-progress-recovery-required',
      'authority-snapshot-interrupted',
    );
    return this.blockedError;
  }

  private async assertAuthorityDirectory(): Promise<void> {
    const directoryStat = await lstat(this.authorityDirectory).catch(() => null);
    if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) {
      throw authorityError('database-corrupt', 'authority-directory-invalid');
    }
    if (!await realpath(this.authorityDirectory).catch(() => null)) {
      throw authorityError('database-corrupt', 'authority-directory-unavailable');
    }
  }
}
