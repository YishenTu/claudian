import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

import initSqlJs, { type SqlJsStatic } from 'sql.js';

import { applyAuthorityMigrations, migrateLegacyAuthorityDatabaseToCurrent } from '@/app/collab/authority/AuthoritySchema';

const NOW = '2026-08-13T00:00:00.000Z';

describe('Authority event retention', () => {
  let SQL: SqlJsStatic;
  beforeAll(async () => { SQL = await initSqlJs(); });

  it('bounds every SQL event writer while preserving original replay sequences', () => {
    const database = new SQL.Database();
    try {
      applyAuthorityMigrations(database);
      database.run('BEGIN');
      for (let sequence = 1; sequence <= 601; sequence++) {
        database.run("INSERT INTO events(event_kind, payload_json, created_at) VALUES ('request.updated', '{}', ?)", [NOW]);
      }
      database.run('COMMIT');
      expect(database.exec('SELECT COUNT(*), MIN(sequence), MAX(sequence) FROM events')[0].values)
        .toEqual([[500, 102, 601]]);
      expect(() => database.run('DELETE FROM events WHERE sequence = 102')).toThrow();
      expect(() => database.run("UPDATE events SET event_kind = 'project.updated' WHERE sequence = 601")).toThrow();
      const reopened = new SQL.Database(database.export());
      try {
        reopened.run("INSERT INTO events(event_kind, payload_json, created_at) VALUES ('host.transfer-changed', '{}', ?)", [NOW]);
        expect(reopened.exec('SELECT COUNT(*), MIN(sequence), MAX(sequence) FROM events')[0].values)
          .toEqual([[500, 103, 602]]);
      } finally { reopened.close(); }
    } finally { database.close(); }
  });

  it('migrates a captured V12 physical handoff image without losing its latest cursor', async () => {
    const bytes = gunzipSync(await readFile('tests/fixtures/collab/authority-v12-inert.sqlite.gz'));
    const database = new SQL.Database(bytes);
    try {
      const latest = database.exec('SELECT MAX(sequence) FROM events')[0].values[0][0];
      expect(migrateLegacyAuthorityDatabaseToCurrent(database)).toBe(1);
      expect(database.exec('SELECT COUNT(*), MAX(sequence) FROM events')[0].values)
        .toEqual([[500, latest]]);
      expect(database.export().byteLength).toBeLessThan(bytes.byteLength);
    } finally { database.close(); }
  });

  it('uses ordered Ticket traversal for both first and continuation all-status pages', () => {
    const database = new SQL.Database();
    try {
      applyAuthorityMigrations(database);
      for (const where of ['', "WHERE updated_at < '2026-09-01' OR (updated_at = '2026-09-01' AND ticket_number < 42)"]) {
        const plan = database.exec(`EXPLAIN QUERY PLAN SELECT * FROM tickets ${where} ORDER BY updated_at DESC, ticket_number DESC LIMIT 50`)[0].values.map(row => String(row[3])).join('\n');
        expect(plan).not.toContain('TEMP B-TREE');
      }
    } finally { database.close(); }
  });
});
