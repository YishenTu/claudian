import { type DeepSeekReader, DeepSeekRemoteError, isRecord } from '../remote/DeepSeekRemoteClient';
import { isCheckpoint } from '../types';

export type DeepSeekAddress = { kind: 'session'; sessionId: string } | { kind: 'subagent'; childSessionId: string; parentSessionId: string; mode: 'one-shot' | 'continuable' };
export interface DeepSeekRecord { readonly type: string; readonly seq: number; readonly time: number; readonly data: Record<string, unknown>; readonly surfaceOp?: unknown }
export interface DeepSeekProjection { readonly asOfSeq: number; readonly values: Record<string, unknown> }

export async function readDeepSeekProjection(client: DeepSeekReader, sessionId: string): Promise<DeepSeekProjection> {
  const value = await client.call('session/projections', { request: { sessionId } });
  if (value === null) throw new DeepSeekRemoteError('DeepSeek native session is missing.', 'session/missing');
  if (!isRecord(value) || !isCheckpoint(value.asOfSeq) || !isRecord(value.values)) throw new Error('Malformed DeepSeek native projections.');
  return { asOfSeq: value.asOfSeq, values: value.values };
}

/** Non-activating, fixed-cut backwards reads. Never turns list hints into a live cursor. */
export async function* readDeepSeekJournal(client: DeepSeekReader, sessionId: string, throughSeq: number, address: DeepSeekAddress = { kind: 'session', sessionId }): AsyncGenerator<DeepSeekRecord[]> {
  if (!isCheckpoint(throughSeq)) throw new Error('Invalid DeepSeek history cut.');
  let beforeSeq: number | undefined;
  for (;;) {
    const page = await client.call('session/page', { request: {
      address, throughSeq, maxMessages: 100,
      ...(beforeSeq !== undefined ? { beforeSeq } : {}),
    } });
    if (!isRecord(page) || !Array.isArray(page.records) || typeof page.hasMore !== 'boolean') throw new Error('Malformed DeepSeek history page.');
    const records = page.records.map(record => {
      if (!isRecord(record) || record.type !== 'event' || !isRecord(record.event)) throw new Error('Malformed DeepSeek history record.');
      const event = record.event;
      if (typeof event.type !== 'string' || !isCheckpoint(event.seq) || typeof event.time !== 'number'
        || !isRecord(event.data) || event.seq > throughSeq || (beforeSeq !== undefined && event.seq >= beforeSeq)) throw new Error('Invalid DeepSeek history record.');
      return event as unknown as DeepSeekRecord;
    }).sort((a, b) => a.seq - b.seq);
    yield records;
    if (!page.hasMore) return;
    if (records.length === 0) throw new Error('DeepSeek history pagination made no progress.');
    beforeSeq = records[0].seq;
  }
}
