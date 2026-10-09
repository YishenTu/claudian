import { NativePeer } from '@test/helpers/deepseek/NativePeer';
import { testDate } from '@test/helpers/testClock';

import { applyDeepSeekPermission, readDeepSeekPermission } from '@/providers/deepseek/execution/DeepSeekPermissions';

let peer: NativePeer;
const time = testDate().getTime();
beforeEach(async () => { peer = new NativePeer(); await peer.open(); });
afterEach(async () => { await peer.close(); });

it('validates effective permission facts across a pinned paginated log before admission', async () => {
  peer.onCall = (method, args) => {
    if (method === 'permissionPresets/catalog') return { options: [{ value: 'workspace-write' }] };
    if (method === 'commands/list') return [{ name: 'permission' }];
    if (method === 'commands/execute') return { result: { kind: 'success' } };
    if (method === 'session/projections') return { asOfSeq: 60, values: { permissions: { currentValue: 'workspace-write' } } };
    if (method === 'session/page') {
      return args.request.beforeSeq ? { hasMore: false, records: [
        { type: 'event', event: { type: 'sandbox/mode', seq: 2, time, data: { mode: 'workspace-write' } } },
        { type: 'event', event: { type: 'approval/policy', seq: 3, time, data: { policy: 'ask' } } },
      ] } : { hasMore: true, records: [{ type: 'event', event: { type: 'turn/end', seq: 60, time, data: {} } }] };
    }
    throw new Error(`Unexpected ${method}`);
  };
  await expect(applyDeepSeekPermission(peer.client, 'root', 'normal', () => {})).resolves.toBe('normal');
  expect(peer.calls.filter(c => c.method === 'session/page').map(c => c.args.request)).toEqual([
    { address: { kind: 'session', sessionId: 'root' }, throughSeq: 60, maxMessages: 100 },
    { address: { kind: 'session', sessionId: 'root' }, throughSeq: 60, beforeSeq: 60, maxMessages: 100 },
  ]);
  expect(peer.calls.find(c => c.method === 'commands/execute')?.args).toEqual({ agentId: 'root', line: '/permission workspace-write', submittedAttachments: [] });
  expect(peer.calls.some(c => c.method === 'session/prompt')).toBe(false);
});

it.each(['nested-error', 'redefined', 'missing-facts'])('rejects %s instead of trusting preset labels or RPC success', async mode => {
  peer.onCall = method => {
    if (method === 'permissionPresets/catalog') return { options: [{ value: 'workspace-write' }] };
    if (method === 'commands/list') return [{ name: 'permission' }];
    if (method === 'commands/execute') return { result: { kind: mode === 'nested-error' ? 'error' : 'success' } };
    if (method === 'session/projections') return { asOfSeq: 5, values: { permissions: { currentValue: 'workspace-write' } } };
    return { hasMore: false, records: mode === 'missing-facts' ? [] : [
      { type: 'event', event: { type: 'sandbox/mode', seq: 2, time, data: { mode: 'danger-full-access' } } },
      { type: 'event', event: { type: 'approval/policy', seq: 3, time, data: { policy: 'never' } } },
    ] };
  };
  await expect(applyDeepSeekPermission(peer.client, 'root', 'normal', () => {})).rejects.toThrow(/permission/i);
});

it('reports unavailable native sessions without using activating follow', async () => {
  peer.onCall = () => null;
  await expect(readDeepSeekPermission(peer.client, 'root')).rejects.toThrow(/missing/i);
  expect(peer.calls.map(call => call.method)).toEqual(['session/projections']);
});
