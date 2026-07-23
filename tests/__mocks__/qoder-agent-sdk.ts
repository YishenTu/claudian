// Mock for @qoder-ai/qoder-agent-sdk
//
// Unit tests must never load the real ESM-only SDK (it spawns qodercli and
// cannot be transformed by Jest). Jest maps every `@qoder-ai/qoder-agent-sdk`
// import to this file. Exported jest.fn hooks let tests drive auth resolution
// and streamed query behavior explicitly.

export const DEFAULT_ACCESS_TOKEN_ENV_VAR = 'QODER_PERSONAL_ACCESS_TOKEN';

export const accessTokenFromEnv = jest.fn((envVar?: string) => ({
  type: 'accessToken' as const,
  accessToken: { envVar: envVar ?? DEFAULT_ACCESS_TOKEN_ENV_VAR },
}));

export const accessToken = jest.fn((token: string) => ({
  type: 'accessToken' as const,
  accessToken: token,
}));

export const qodercliAuth = jest.fn(() => ({ type: 'qodercli' as const }));

export const mockQueryHandle = {
  initializationResult: jest.fn().mockResolvedValue({
    skills: [],
    commands: [],
    agents: [],
    plugins: [],
  }),
  getAvailableModels: jest.fn().mockResolvedValue([]),
  supportedCommands: jest.fn().mockResolvedValue([]),
  supportedAgents: jest.fn().mockResolvedValue([]),
  interrupt: jest.fn().mockResolvedValue(undefined),
  setModel: jest.fn().mockResolvedValue(undefined),
  setPermissionMode: jest.fn().mockResolvedValue(undefined),
  rewindFiles: jest.fn().mockResolvedValue({ filesChanged: [] }),
  close: jest.fn().mockResolvedValue(undefined),
};

export function query(_args: { prompt: unknown; options: unknown }): AsyncGenerator<unknown> & typeof mockQueryHandle {
  const gen = (async function* () {
    // Default: yield nothing. Tests override behavior via the exported hooks.
  })() as AsyncGenerator<unknown> & typeof mockQueryHandle;

  return Object.assign(gen, mockQueryHandle);
}
