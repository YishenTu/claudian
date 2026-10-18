export type ACPLogicalMethod =
  | 'initialize'
  | 'newSession'
  | 'loadSession'
  | 'prompt'
  | 'cancel'
  | 'setModel'
  | 'setMode';


export const ACP_METHOD_NAMES = {
  cancel: 'session/cancel',
  initialize: 'initialize',
  loadSession: 'session/load',
  newSession: 'session/new',
  prompt: 'session/prompt',
  setModel: 'session/set_model',
  setMode: 'session/set_mode',
} as const satisfies Record<ACPLogicalMethod, string>;

export const ACP_SERVER_NOTIFICATION_METHODS = {
  sessionUpdate: 'session/update',
} as const;

export const ACP_SERVER_REQUEST_METHODS = {
  requestPermission: 'session/request_permission',
} as const;
