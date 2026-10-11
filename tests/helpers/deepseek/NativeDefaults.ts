import { testDate } from '@test/helpers/testClock';

import type { NativePeer } from './NativePeer';

export interface NativeDefaultsOptions {
  /** Durable cursor native reports in projections and follow snapshots. */
  readonly seq: () => number;
  /** Sessions native lists, each idle with its agent available. */
  readonly roster: () => readonly string[];
  /** Permission preset native reports for a session; defaults to `workspace-write`. */
  readonly permission?: (sessionId: string) => string;
  /** Records a successful `/permission <value>` command. Without it native rejects `commands/execute` as unexpected. */
  readonly setPermission?: (sessionId: string, value: string) => void;
  /** Native command catalog; defaults to `/permission` only. */
  readonly commands?: readonly unknown[];
  /** Native skill catalog; defaults to none. */
  readonly skills?: readonly unknown[];
  /** Live projection values of a session beyond its preset and permission; also baselined for roster sessions. */
  readonly projections?: (sessionId: string) => Record<string, unknown>;
  /** Rows native lists when a session's job stream opens; defaults to none. */
  readonly jobs?: (sessionId: string) => readonly unknown[];
}

export type NativeCall = Parameters<NativePeer['onCall']>;
export type NativeOpen = NativePeer['onOpen'];

/**
 * Generic native plumbing for an execution session: catalogs, permission projections and pages, acknowledgements and
 * stream baselines. Session identity (`session/create`) and any behavior a test asserts stay with the test, which
 * answers those methods before delegating here. Unknown methods fail as unexpected native calls.
 */
export function nativeDefaults(options: NativeDefaultsOptions): { call: (...args: NativeCall) => unknown; open: NativeOpen } {
  const time = testDate().getTime();
  const permission = (sessionId: string): string => options.permission?.(sessionId) ?? 'workspace-write';
  const call = (method: string, args: Record<string, any>): unknown => {
    if (method === 'session/list') return { items: options.roster().map(sessionId => ({ sessionId, agentAvailable: true, running: false })) };
    if (method === 'permissionPresets/catalog') return { options: [{ value: 'workspace-write' }, { value: 'read-only' }, { value: 'danger-full-access' }] };
    if (method === 'commands/list') return options.commands ?? [{ name: 'permission' }];
    if (method === 'skills/list') return { skills: options.skills ?? [] };
    if (method === 'commands/execute' && options.setPermission && typeof args.line === 'string' && args.line.startsWith('/permission ')) {
      options.setPermission(args.agentId, args.line.slice('/permission '.length));
      return { result: { kind: 'success' } };
    }
    if (method === 'session/projections') {
      const sessionId = args.request.sessionId as string;
      return { asOfSeq: options.seq(), values: { agentPreset: 'claudian', permissions: { currentValue: permission(sessionId) }, ...options.projections?.(sessionId) } };
    }
    if (method === 'session/page') {
      const mode = permission(args.request.address.sessionId ?? args.request.address.childSessionId);
      return { hasMore: false, records: [
        { type: 'event', event: { type: 'sandbox/mode', seq: 1, time, data: { mode } } },
        { type: 'event', event: { type: 'approval/policy', seq: 2, time, data: { policy: mode === 'danger-full-access' ? 'never' : 'ask' } } },
      ] };
    }
    if (method === 'session/prompt') return { accepted: true };
    if (method === 'workspace/unarchiveSession') return { archivedSessionIds: [] };
    if (method === '$events/result') return {};
    throw new Error(`Unexpected native call ${method}`);
  };
  const open: NativeOpen = (endpoint, args, send) => {
    if (endpoint === 'session/control') {
      const projections = options.projections;
      send({ type: 'baseline', value: { projections: projections
        ? Object.fromEntries(options.roster().map(id => [id, { asOfSeq: options.seq(), values: projections(id) }]))
        : {} } });
    }
    if (endpoint === 'session/follow') send({ type: 'snapshot', cursor: options.seq(), records: [] });
    if (endpoint === 'job/list') send({ type: 'rows', jobs: options.jobs?.(args.request.sessionId) ?? [] });
  };
  return { call, open };
}
