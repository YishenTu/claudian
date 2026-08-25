import type { AuthorityDatabaseConnection } from '@/app/collab/authority/SqlJsProjectDatabase';
import { CollabError } from '@/core/collab/ClaudianCollabError';

function metadataError(reason: string): CollabError {
  return new CollabError({
    code: 'authority-integrity-error',
    recoveryActions: ['open-diagnostics'],
    safeContext: { reason },
  });
}

function assertGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw metadataError('authority-generation-invalid');
  }
}

export class AuthorityMetadataRepository {
  getGeneration(connection: AuthorityDatabaseConnection): number {
    const generation = connection.get(`
      SELECT authority_generation
      FROM authority_metadata
      WHERE singleton = 1
    `)?.authority_generation;
    if (typeof generation !== 'number') {
      throw metadataError('authority-generation-missing');
    }
    assertGeneration(generation);
    return generation;
  }

  setGeneration(
    connection: AuthorityDatabaseConnection,
    expectedGeneration: number,
    nextGeneration: number,
  ): void {
    assertGeneration(expectedGeneration);
    assertGeneration(nextGeneration);
    if (nextGeneration !== expectedGeneration + 1) {
      throw metadataError('authority-generation-transition-invalid');
    }
    const changes = connection.run(`
      UPDATE authority_metadata
      SET authority_generation = ?
      WHERE singleton = 1 AND authority_generation = ?
    `, [nextGeneration, expectedGeneration]);
    if (changes !== 1) throw metadataError('authority-generation-stale');
  }

  installGeneration(connection: AuthorityDatabaseConnection, generation: number): void {
    assertGeneration(generation);
    const changes = connection.run(`
      UPDATE authority_metadata
      SET authority_generation = ?
      WHERE singleton = 1
    `, [generation]);
    if (changes !== 1) throw metadataError('authority-generation-missing');
  }
}
