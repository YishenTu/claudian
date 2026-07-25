import type { AuxQueryConfig, AuxQueryRunner } from '../../../core/auxiliary/AuxQueryRunner';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { getVaultPath } from '../../../utils/path';
import { AcpSubprocess } from '../../acp';
import { decodeKimiModelId, isKimiModelSelectionId } from '../models';
import { buildKimiRuntimeEnv } from './KimiRuntimeEnvironment';

// One-shot `kimi --prompt` runs for auxiliary services (title generation, instruction
// refinement, inline edit). Prompt mode forces auto permission and auto-approves
// tool calls, so each query is a self-contained subprocess.
export class KimiAuxQueryRunner implements AuxQueryRunner {
  private activeProcess: AcpSubprocess | null = null;

  constructor(
    private readonly plugin: ProviderHost,
  ) {}

  async query(config: AuxQueryConfig, prompt: string): Promise<string> {
    if (config.abortController?.signal.aborted) {
      throw new Error('Cancelled');
    }

    const cwd = getVaultPath(this.plugin.app) ?? process.cwd();
    const resolvedCliPath = await this.plugin.getResolvedProviderCliPath('kimi') ?? 'kimi';
    const settings = this.plugin.settings as unknown as Record<string, unknown>;
    const runtimeEnv = buildKimiRuntimeEnv(settings, resolvedCliPath);

    // `kimi --prompt` has no system-prompt flag; the instruction text travels with
    // the prompt. `--output-format text` (the prompt-mode default) writes only the
    // assistant text to stdout.
    const fullPrompt = config.systemPrompt.trim()
      ? `${config.systemPrompt}\n\n${prompt}`
      : prompt;

    const args = ['--prompt', fullPrompt, '--output-format', 'text'];
    const model = this.resolveModel(config.model);
    if (model) {
      args.push('--model', model);
    }

    const subprocess = new AcpSubprocess({
      args,
      command: resolvedCliPath,
      cwd,
      env: runtimeEnv,
    });
    this.activeProcess = subprocess;

    let stdout = '';
    const closed = new Promise<Error | undefined>((resolve) => {
      subprocess.onClose((error) => resolve(error));
    });
    const abortHandler = (): void => {
      void subprocess.shutdown().catch(() => {});
    };
    config.abortController?.signal.addEventListener('abort', abortHandler, { once: true });

    try {
      subprocess.start();
      subprocess.stdout.on('data', (chunk: Buffer | string) => {
        stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        config.onTextChunk?.(stdout);
      });

      const closeError = await closed;
      if (config.abortController?.signal.aborted) {
        throw new Error('Cancelled');
      }
      if (closeError) {
        const stderr = subprocess.getStderrSnapshot();
        throw new Error(
          stderr ? `${closeError.message}\n\n${stderr}` : closeError.message,
          { cause: closeError },
        );
      }
      return stdout.trim();
    } finally {
      config.abortController?.signal.removeEventListener('abort', abortHandler);
      if (this.activeProcess === subprocess) {
        this.activeProcess = null;
      }
    }
  }

  reset(): void {
    const subprocess = this.activeProcess;
    this.activeProcess = null;
    if (subprocess) {
      void subprocess.shutdown().catch(() => {});
    }
  }

  private resolveModel(explicitModel?: string): string | null {
    const trimmed = explicitModel?.trim() ?? '';
    if (!trimmed) {
      return null;
    }
    return isKimiModelSelectionId(trimmed)
      ? decodeKimiModelId(trimmed)
      : trimmed;
  }
}
