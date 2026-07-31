import type { Options } from '@anthropic-ai/claude-agent-sdk';

import type { AuxQueryConfig, AuxQueryRunner } from '../../../core/auxiliary/AuxQueryRunner';
import { getProviderSettingsSnapshotWithModel } from '../../../core/providers/conversationModel';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { runColdStartQuery } from './claudeColdStartQuery';

export interface ClaudeAuxQueryRunnerOptions {
  hooks?: Options['hooks'];
  tools?: readonly string[];
}

export class ClaudeAuxQueryRunner implements AuxQueryRunner {
  private sessionId: string | null = null;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly options: ClaudeAuxQueryRunnerOptions = {},
  ) {}

  async query(config: AuxQueryConfig, prompt: string): Promise<string> {
    const providerSettings = getProviderSettingsSnapshotWithModel(
      this.plugin.settings,
      'claude',
      config.model,
    );
    const result = await runColdStartQuery({
      plugin: this.plugin,
      systemPrompt: config.systemPrompt,
      tools: this.options.tools ? [...this.options.tools] : undefined,
      hooks: this.options.hooks,
      resumeSessionId: this.sessionId ?? undefined,
      abortController: config.abortController,
      onTextChunk: config.onTextChunk,
      providerSettings,
    }, prompt);

    this.sessionId = result.sessionId;
    return result.text;
  }

  canContinue(): boolean {
    return this.sessionId !== null;
  }

  reset(): void {
    this.sessionId = null;
  }
}
