export type ACPLogicalMethod =
  | 'initialize'
  | 'authenticate'
  | 'newSession'
  | 'loadSession'
  | 'forkSession'
  | 'listSessions'
  | 'prompt'
  | 'cancel'
  | 'setModel'
  | 'setMode'
  | 'setConfigOption';

export type ACPMethodOverrides = Partial<Record<ACPLogicalMethod, string | string[]>>;

const ACP_METHOD_CANDIDATES = {
  authenticate: ['authenticate'],
  cancel: ['session/cancel', 'cancel'],
  initialize: ['initialize'],
  forkSession: ['session/fork'],
  listSessions: ['session/list', 'listSessions'],
  loadSession: ['session/load', 'loadSession'],
  newSession: ['session/new', 'newSession'],
  prompt: ['session/prompt', 'prompt'],
  setConfigOption: ['session/set_config_option', 'setSessionConfigOption'],
  setModel: ['session/set_model', 'setSessionModel'],
  setMode: ['session/set_mode', 'setSessionMode'],
} as const satisfies Record<ACPLogicalMethod, readonly string[]>;

export const ACP_SERVER_NOTIFICATION_ALIASES = {
  sessionUpdate: ['session/update', 'sessionUpdate'],
} as const;

export const ACP_SERVER_REQUEST_ALIASES = {
  createTerminal: ['terminal/create', 'terminalCreate'],
  killTerminal: ['terminal/kill', 'terminalKill'],
  readTextFile: ['fs/read_text_file', 'fs/readTextFile'],
  releaseTerminal: ['terminal/release', 'terminalRelease'],
  requestPermission: ['session/request_permission', 'requestPermission'],
  terminalOutput: ['terminal/output', 'terminalOutput'],
  waitForTerminalExit: ['terminal/wait_for_exit', 'terminalWaitForExit'],
  writeTextFile: ['fs/write_text_file', 'fs/writeTextFile'],
} as const;

export function getACPMethodCandidates(
  logicalMethod: ACPLogicalMethod,
  overrides?: ACPMethodOverrides,
): string[] {
  const override = overrides?.[logicalMethod];
  if (override) {
    return Array.isArray(override) ? [...override] : [override];
  }
  return [...ACP_METHOD_CANDIDATES[logicalMethod]];
}
