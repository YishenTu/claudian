import { NativePeer } from '@test/helpers/deepseek/NativePeer';

import { DeepSeekSessionObserver } from '@/providers/deepseek/execution/DeepSeekSessionObserver';
import { DeepSeekRoster } from '@/providers/deepseek/runtime/DeepSeekRoster';

let peer: NativePeer;
let roster: DeepSeekRoster;
let observer: DeepSeekSessionObserver | undefined;
const row = (sessionId: string, extra = {}) => ({ sessionId, running: false, agentAvailable: true, ...extra });

beforeEach(async () => {
  peer = new NativePeer(); await peer.open();
  roster = new DeepSeekRoster(peer.client, error => { throw error; });
});
afterEach(async () => { observer?.dispose(); observer = undefined; roster.dispose(); await peer.close(); });

function observe(rootId: string): DeepSeekSessionObserver {
  roster.claim(rootId, () => {});
  return new DeepSeekSessionObserver(peer.client, roster, rootId, () => {}, error => { throw error; });
}

it('keeps status changes during roster loading and waits for descendant job baselines', async () => {
  let releaseRoster!: (value: unknown) => void;
  let childJobs!: (value: unknown) => void;
  peer.onCall = () => new Promise(resolve => { releaseRoster = resolve; });
  peer.onOpen = (endpoint, args, send) => {
    if (endpoint === 'session/control') send({ type: 'baseline', value: { projections: { root: { values: { subagentCatalog: [{ id: 'child', mode: 'one-shot' }, { id: 'cold', mode: 'continuable' }] } }, child: { values: { subagent: { mode: 'one-shot', seq: 1 } } } } } });
    if (endpoint === 'session/follow') send({ type: 'snapshot', cursor: 0, records: [], projections: { asOfSeq: 0, values: {} } });
    if (endpoint === 'job/list') {
      if (args.request.sessionId === 'child') childJobs = send;
      else send({ type: 'rows', jobs: [{ id: 'unowned', status: 'running' }] });
    }
  };
  const listing = roster.start();
  observer = observe('root');
  const ready = observer.start();
  await until(() => !!releaseRoster);
  peer.send('$events', { type: 'emit', event: 'api-session/status', args: ['root', true] });
  releaseRoster({ items: [row('root', { parentSessionId: 'source' }), row('child', { parentSessionId: 'root', origin: 'subagent' }), row('cold', { parentSessionId: 'root', origin: 'subagent', agentAvailable: false }), row('sibling')] });
  await listing;
  await until(() => !!childJobs);
  expect(observer.hasWork()).toBe(true);
  childJobs({ type: 'rows', jobs: [{ id: 'child-job', owner: 'child', status: 'running' }, { id: 'foreign', owner: 'sibling', status: 'running' }] });
  await ready;
  expect(observer.permissionBoundaryAvailable()).toBe(false);
  peer.send('$events', { type: 'emit', event: 'api-session/status', args: ['root', false] });
  await until(() => observer!.permissionBoundaryAvailable());
  expect(observer.hasWork()).toBe(true);
  expect(observer.ownedJobs()).toEqual([{ id: 'child-job', owner: 'child', status: 'running' }]);
  expect([...peer.streams.values()].filter(s => s.endpoint === 'session/follow').map(s => s.args.request.address)).toEqual(expect.arrayContaining([
    { kind: 'session', sessionId: 'root' }, { kind: 'subagent', childSessionId: 'child', parentSessionId: 'root', mode: 'one-shot' },
  ]));
  expect([...peer.streams.values()].some(s => JSON.stringify(s.args).includes('cold'))).toBe(false);
  childJobs({ type: 'rows', jobs: [] });
  await until(() => !observer!.hasWork());
  expect(observer.hasWork()).toBe(false);
});

it('follows a native child only after its durable identity, and keeps it busy until then', async () => {
  const rejected: unknown[] = [];
  const errors: Error[] = [];
  peer.onCall = () => ({ items: [row('root'), row('child', { parentSessionId: 'root', origin: 'subagent', running: true })] });
  peer.onOpen = (endpoint, args, send, fail) => {
    if (endpoint === 'session/control') send({ type: 'baseline', value: { projections: { root: { values: { subagentCatalog: [{ id: 'child', mode: 'one-shot', label: 'task' }] } }, child: { values: { subagent: null } } } } });
    if (endpoint === 'session/follow') {
      // rc.2 validates the child's durable descriptor identity before following.
      if (args.request.address.kind === 'subagent' && !(roster.projection('child')?.subagent)) {
        rejected.push(args.request.address); fail!({ code: 'subagent/catalog-diagnostic', message: 'subagent descriptor is corrupt' }); return;
      }
      send({ type: 'snapshot', cursor: 0, records: [], projections: { asOfSeq: 0, values: {} } });
    }
    if (endpoint === 'job/list') send({ type: 'rows', jobs: [] });
  };
  await roster.start();
  roster.claim('root', () => {});
  observer = new DeepSeekSessionObserver(peer.client, roster, 'root', () => {}, error => errors.push(error));
  const ready = observer.start();
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(rejected).toEqual([]);
  expect(errors).toEqual([]);
  expect(observer.hasWork()).toBe(true);
  peer.send('session/control', { type: 'projection', sessionId: 'child', key: 'subagent', value: { mode: 'one-shot', label: 'task', seq: 3 }, seq: 3 });
  await ready;
  expect([...peer.streams.values()].filter(s => s.endpoint === 'session/follow').map(s => s.args.request.address)).toContainEqual(
    { kind: 'subagent', childSessionId: 'child', parentSessionId: 'root', mode: 'one-shot' });
  expect(rejected).toEqual([]);
  expect(errors).toEqual([]);
});

it('projects restored queues and makes disconnect unknown until all baselines return', async () => {
  peer.onCall = () => ({ items: [row('root')] });
  peer.onOpen = (endpoint, _args, send) => {
    if (endpoint === 'session/control') send({ type: 'baseline', value: { projections: { root: { asOfSeq: 4, values: { inbox: { 'next-turn': [{ id: 'queued', content: [{ type: 'text', text: 'old task' }], source: { kind: 'user', rpcId: 'old' } }] } } } } } });
    if (endpoint === 'session/follow') send({ type: 'snapshot', cursor: 4, records: [], projections: { asOfSeq: 4, values: {} } });
    if (endpoint === 'job/list') send({ type: 'rows', jobs: [] });
  };
  await roster.start();
  observer = observe('root');
  await observer.start();
  expect(observer.queuedItems('root')).toMatchObject([{ id: 'queued', source: { rpcId: 'old' } }]);
  expect(observer.hasWork()).toBe(true);
  roster.reset();
  expect(observer.permissionBoundaryAvailable()).toBe(false);
  expect(observer.hasWork()).toBe(true);
});

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Native fixture condition timed out.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
