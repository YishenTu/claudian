import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

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
  writeFileSync(cliPath, `#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
if (process.argv.includes('--version')) { console.log('opencode v2.0.12'); return; }
if (!process.argv.includes('serve')) process.exit(3);
const authorization = 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_PASSWORD).toString('base64');
const readSessions = () => fs.existsSync(process.env.OPENCODE_DB) ? JSON.parse(fs.readFileSync(process.env.OPENCODE_DB, 'utf8')) : {};
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== authorization) { res.writeHead(401).end(); return; }
  const match = /^\\/api\\/session\\/([^/]+)(\\/message)?$/.exec(new URL(req.url, 'http://localhost').pathname);
  const sessionId = match && decodeURIComponent(match[1]);
  const session = sessionId ? readSessions()[sessionId] : undefined;
  res.setHeader('Content-Type', 'application/json');
  if (!session) {
    res.writeHead(404).end(JSON.stringify({ _tag: 'SessionNotFoundError', sessionID: sessionId, message: 'Session not found: ' + sessionId }));
    return;
  }
  res.end(JSON.stringify(match[2]
    ? { data: session.messages, cursor: { previous: null, next: null } }
    : { data: { id: sessionId, ...(session.model ? { model: session.model } : {}) } }));
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: 'http://127.0.0.1:' + server.address().port })));
process.stdin.resume(); process.stdin.on('end', () => server.close());
`, { mode: 0o700 });
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
