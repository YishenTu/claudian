import { readDeepSeekJournal, readDeepSeekProjection } from '../history/DeepSeekJournal';
import { type DeepSeekReader,isRecord } from '../remote/DeepSeekRemoteClient';

export type DeepSeekPermission = 'normal' | 'yolo' | 'read-only';
const PRESETS = { normal: 'workspace-write', yolo: 'danger-full-access', 'read-only': 'read-only' } as const;

/** The native permission owner records semantics; labels and command receipts are insufficient. */
export async function readDeepSeekPermission(client: DeepSeekReader, sessionId: string): Promise<DeepSeekPermission> {
  const projection = await readDeepSeekProjection(client, sessionId);
  const permissions = projection.values.permissions;
  const preset = isRecord(permissions) ? permissions.currentValue : undefined;
  let sandbox: unknown;
  let approval: unknown;
  for await (const records of readDeepSeekJournal(client, sessionId, projection.asOfSeq)) {
    for (const record of records.reverse()) {
      if (sandbox === undefined && record.type === 'sandbox/mode') sandbox = record.data.mode;
      if (approval === undefined && record.type === 'approval/policy') approval = record.data.policy;
    }
    if (sandbox !== undefined && approval !== undefined) break;
  }
  for (const [mode, native] of Object.entries(PRESETS)) {
    if (preset === native && sandbox === native && approval === (mode === 'yolo' ? 'never' : 'ask')) return mode as DeepSeekPermission;
  }
  throw new Error('DeepSeek permission state is missing or incompatible with the canonical native presets. Restore the native permission presets before continuing.');
}

export async function applyDeepSeekPermission(client: DeepSeekReader, sessionId: string, mode: DeepSeekPermission, assertBoundary: () => void): Promise<DeepSeekPermission> {
  const native = PRESETS[mode];
  if (!native) throw new Error('Unsupported DeepSeek permission mode.');
  const catalog = await client.call('permissionPresets/catalog');
  if (!isRecord(catalog) || !Array.isArray(catalog.options) || !catalog.options.some(option => isRecord(option) && option.value === native)) {
    throw new Error(`DeepSeek native permission preset ${native} is unavailable.`);
  }
  const commands = await client.call('commands/list', { agentId: sessionId });
  if (!Array.isArray(commands) || !commands.some(command => isRecord(command) && command.name === 'permission')) {
    throw new Error('DeepSeek native permission command is unavailable.');
  }
  assertBoundary();
  const response = await client.call('commands/execute', { agentId: sessionId, line: `/permission ${native}`, submittedAttachments: [] });
  if (!isRecord(response) || !isRecord(response.result) || response.result.kind !== 'success') {
    throw new Error(`DeepSeek could not select permission preset ${native}.`);
  }
  const actual = await readDeepSeekPermission(client, sessionId);
  if (actual !== mode) throw new Error('DeepSeek native permission selection did not match the requested mode.');
  return actual;
}
