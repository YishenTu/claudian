export interface OpenCodeProviderState {
  sessionId: string | null;
  threadId: string | null;
  sessionFilePath?: string;
  cwd: string;
}
