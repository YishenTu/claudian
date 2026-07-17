import type { AuxQueryConfig, AuxQueryRunner } from '../../../core/auxiliary/AuxQueryRunner';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { getVaultPath } from '../../../utils/path';
import { runGrokHeadless } from './GrokHeadlessRunner';

export class GrokAuxQueryRunner implements AuxQueryRunner {
  private abortController: AbortController | null = null;

  constructor(private readonly plugin: ProviderHost) {}

  async query(config: AuxQueryConfig, prompt: string): Promise<string> {
    const cliPath = await this.plugin.getResolvedProviderCliPath('grok');
    if (!cliPath) {
      throw new Error(
        'Grok CLI not found. Install Grok Build or set the Grok CLI path in Claudian settings.',
      );
    }

    this.abortController = config.abortController || new AbortController();
    return runGrokHeadless(this.plugin, cliPath, prompt, {
      cwd: getVaultPath(this.plugin.app) || process.cwd(),
      systemPrompt: config.systemPrompt,
      model: config.model,
      signal: this.abortController.signal,
      onTextChunk: config.onTextChunk,
    });
  }

  reset(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
}
