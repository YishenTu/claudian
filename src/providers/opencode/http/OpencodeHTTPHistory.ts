import { isRecord } from './OpencodeHTTPClient';
import type { OpencodeServerLease } from './OpencodeServerService';

type NativeMessage = Record<string, unknown>;

/** The native message API accepts at most 200 messages per page. */
const MAX_PAGE_SIZE = 200;
/** A backward read usually needs only the latest turn, so it starts small and grows. */
const FIRST_BACKWARD_PAGE_SIZE = 16;

/** Native cursors carry order; do not repeat order when following a cursor. */
async function* readPages(
  client: Pick<OpencodeServerLease, 'request'>,
  sessionId: string,
  order: 'asc' | 'desc',
  pageSize: (page: number) => number,
): AsyncGenerator<NativeMessage[]> {
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let index = 0; ; index += 1) {
    const query = new URLSearchParams({ limit: String(pageSize(index)), ...(cursor ? { cursor } : { order }) });
    const page = await client.request(`/api/session/${encodeURIComponent(sessionId)}/message?${query}`);
    if (!isRecord(page) || !Array.isArray(page.data) || !page.data.every(isRecord)) throw new Error('Invalid OpenCode history response.');
    if (page.data.length) yield page.data;
    cursor = isRecord(page.cursor) && typeof page.cursor.next === 'string' ? page.cursor.next : undefined;
    if (!cursor) return;
    if (cursors.has(cursor)) throw new Error('OpenCode returned a repeated history cursor.');
    cursors.add(cursor);
  }
}

/** A native session's messages, oldest first. */
export async function readOpencodeHTTPMessages(client: Pick<OpencodeServerLease, 'request'>, sessionId: string): Promise<NativeMessage[]> {
  const messages: NativeMessage[] = [];
  for await (const page of readPages(client, sessionId, 'asc', () => MAX_PAGE_SIZE)) messages.push(...page);
  return messages;
}

/** A native session's messages, newest first; an older page is requested only when the consumer reaches it. */
export async function* readOpencodeHTTPMessagesBackward(client: Pick<OpencodeServerLease, 'request'>, sessionId: string): AsyncGenerator<NativeMessage> {
  for await (const page of readPages(client, sessionId, 'desc', index => Math.min(FIRST_BACKWARD_PAGE_SIZE * 2 ** index, MAX_PAGE_SIZE))) yield* page;
}
