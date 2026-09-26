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

export const ACP_METHOD_NAMES = {
  authenticate: 'authenticate',
  cancel: 'session/cancel',
  initialize: 'initialize',
  forkSession: 'session/fork',
  listSessions: 'session/list',
  loadSession: 'session/load',
  newSession: 'session/new',
  prompt: 'session/prompt',
  setConfigOption: 'session/set_config_option',
  setModel: 'session/set_model',
  setMode: 'session/set_mode',
} as const satisfies Record<ACPLogicalMethod, string>;

export const ACP_SERVER_NOTIFICATION_METHODS = {
  sessionUpdate: 'session/update',
} as const;

export const ACP_SERVER_REQUEST_METHODS = {
  createTerminal: 'terminal/create',
  killTerminal: 'terminal/kill',
  readTextFile: 'fs/read_text_file',
  releaseTerminal: 'terminal/release',
  requestPermission: 'session/request_permission',
  terminalOutput: 'terminal/output',
  waitForTerminalExit: 'terminal/wait_for_exit',
  writeTextFile: 'fs/write_text_file',
} as const;
