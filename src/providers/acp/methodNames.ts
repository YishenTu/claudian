export type ACPLogicalMethod =
  | 'initialize'
  | 'newSession'
  | 'loadSession'
  | 'resumeSession'
  | 'closeSession'
  | 'setConfigOption'
  | 'prompt'
  | 'cancel'
  | 'setModel'
  | 'setMode';


export const ACP_METHOD_NAMES = {
  cancel: 'session/cancel',
  closeSession: 'session/close',
  initialize: 'initialize',
  loadSession: 'session/load',
  newSession: 'session/new',
  prompt: 'session/prompt',
  resumeSession: 'session/resume',
  setConfigOption: 'session/set_config_option',
  setModel: 'session/set_model',
  setMode: 'session/set_mode',
} as const satisfies Record<ACPLogicalMethod, string>;

export const ACP_SERVER_NOTIFICATION_METHODS = {
  sessionUpdate: 'session/update',
} as const;

export const ACP_SERVER_REQUEST_METHODS = {
  createElicitation: 'elicitation/create',
  requestPermission: 'session/request_permission',
} as const;
