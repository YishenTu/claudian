import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { writeOpencodeNativePeer } from './OpencodeNativePeer';

export type FakeOpencodeNativeMessage = Record<string, unknown> & { id: string; type: string };

interface FakeOpencodeSession {
  model?: { providerID: string; id: string };
  messages: FakeOpencodeNativeMessage[];
}

/**
 * Writes an `opencode serve` stand-in that serves native history only from the
 * database its launch names in `OPENCODE_DB`. The database is a JSON session map,
 * so a server launched against another database cannot see its sessions.
 */
export function writeFakeOpencodeHistoryCLI(directory: string): string {
  const cliPath = path.join(directory, 'opencode-history.cjs');
  writeOpencodeNativePeer(cliPath, { scenario: 'history', version: '2.0.12' });
  return cliPath;
}

/** Adds or replaces one native session in a fake database file. */
export function seedFakeOpencodeSession(databasePath: string, sessionId: string, session: FakeOpencodeSession): void {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const sessions = existsSync(databasePath)
    ? JSON.parse(readFileSync(databasePath, 'utf8')) as Record<string, FakeOpencodeSession>
    : {};
  sessions[sessionId] = session;
  writeFileSync(databasePath, JSON.stringify(sessions));
}
