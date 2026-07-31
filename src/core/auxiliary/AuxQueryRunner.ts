export interface AuxQueryConfig {
  systemPrompt: string;
  model?: string;
  abortController?: AbortController;
  onTextChunk?: (accumulatedText: string) => void;
}

export interface AuxQueryRunner {
  query(config: AuxQueryConfig, prompt: string): Promise<string>;
  reset(): void;
  /** Reports whether the last successful query established resumable provider state. */
  canContinue?(): boolean;
}
