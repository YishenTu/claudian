import { isRecord } from './OpencodeHTTPClient';
import type { OpencodeServerLease } from './OpencodeServerService';

/** Native cursors carry order; do not repeat order when following a cursor. */
export async function readOpencodeHTTPMessages(client: Pick<OpencodeServerLease, 'request'>, sessionId: string): Promise<Array<Record<string, unknown>>> {
  const messages: Array<Record<string, unknown>> = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ limit: '200', ...(cursor ? { cursor } : { order: 'asc' }) });
    const page = await client.request(`/api/session/${encodeURIComponent(sessionId)}/message?${query}`);
    if (!isRecord(page) || !Array.isArray(page.data) || !page.data.every(isRecord)) throw new Error('Invalid OpenCode history response.');
    messages.push(...page.data);
    cursor = isRecord(page.cursor) && typeof page.cursor.next === 'string' ? page.cursor.next : undefined;
    if (cursor && cursors.has(cursor)) throw new Error('OpenCode returned a repeated history cursor.');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return messages;
}
