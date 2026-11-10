import { NativePeer } from '@test/helpers/deepseek/NativePeer';

import { DeepSeekRoster } from '@/providers/deepseek/runtime/DeepSeekRoster';

let peer: NativePeer;
let roster: DeepSeekRoster;
const row = (sessionId: string, extra = {}) => ({ sessionId, running: false, agentAvailable: true, ...extra });

beforeEach(async () => {
  peer = new NativePeer(); await peer.open();
  roster = new DeepSeekRoster(peer.client, error => { throw error; });
});
afterEach(async () => { roster.dispose(); await peer.close(); });

it('routes subagent work to its claimed root and keeps forks, which name their source as native parent, independent', async () => {
  const child = (parentSessionId: string) => ({ parentSessionId, origin: 'subagent' });
  peer.onCall = () => ({ items: [row('source'), row('fork', { parentSessionId: 'source' }), row('fork-child', child('fork')), row('source-child', child('source'))] });
  peer.onOpen = (endpoint, _args, send) => {
    if (endpoint === 'session/control') send({ type: 'baseline', value: { projections: {} } });
  };
  const sourceQuestions: unknown[] = []; const forkQuestions: unknown[] = [];
  roster.claim('source', event => sourceQuestions.push(event.eventId));
  await roster.start();
  // A closed fork stays loaded natively; its work must not become the source's.
  peer.send('$events', { type: 'waterfall', eventId: 'fork-question', event: 'user-questions/request', agentId: 'fork-child', request: {} });
  peer.send('$events', { type: 'waterfall', eventId: 'source-own', event: 'user-questions/request', agentId: 'source-child', request: {} });
  await until(() => sourceQuestions.length === 1);
  expect(sourceQuestions).toEqual(['source-own']);
  expect(roster.owner('fork')).toBeUndefined();
  expect(roster.owner('fork-child')).toBeUndefined();
  // Reopening the fork claims it and receives the interaction that was waiting for an owner.
  roster.claim('fork', event => forkQuestions.push(event.eventId));
  expect(forkQuestions).toEqual(['fork-question']);
  expect(roster.owner('fork-child')).toBe('fork');
  expect(sourceQuestions).toEqual(['source-own']);
  expect(() => roster.claim('fork', () => {})).toThrow(/already open/);
});

it('applies both batched (0.2.2+) and per-key (≤0.2.1) projection frames', async () => {
  const failures: Error[] = [];
  roster.dispose();
  roster = new DeepSeekRoster(peer.client, error => failures.push(error));
  peer.onCall = () => ({ items: [row('root')] });
  peer.onOpen = (endpoint, _args, send) => {
    if (endpoint === 'session/control') send({ type: 'baseline', value: { projections: { root: { asOfSeq: 0, values: { inbox: { 'next-turn': [] } } } } } });
  };
  await roster.start();
  await until(() => roster.ready);
  peer.send('session/control', { type: 'projection', sessionId: 'root', seq: 1, changes: [
    { key: 'subagentCatalog', val: [{ id: 'child', mode: 'continuable' }] },
    { key: 'inbox', val: { 'next-turn': ['queued'] } },
  ] });
  peer.send('session/control', { type: 'projection', sessionId: 'child', key: 'subagent', value: { mode: 'continuable' }, seq: 2 });
  await until(() => roster.projection('child') !== undefined || failures.length > 0);
  expect(failures).toEqual([]);
  expect(roster.projection('root')).toEqual({ inbox: { 'next-turn': ['queued'] }, subagentCatalog: [{ id: 'child', mode: 'continuable' }] });
  expect(roster.projection('child')).toEqual({ subagent: { mode: 'continuable' } });
});

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Native fixture condition timed out.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
