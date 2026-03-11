import * as readline from 'readline';

import { spawnGeminiCli } from '../../../core/agent/customSpawn';
import { QueryOptionsBuilder } from '../../../core/agent/QueryOptionsBuilder';
import { TITLE_GENERATION_SYSTEM_PROMPT } from '../../../core/prompts/titleGeneration';
import { parseGeminiJsonLine } from '../../../core/sdk/transformSDKMessage';
import type GeminianPlugin from '../../../main';
import { getEnhancedPath, getMissingNodeError, parseEnvironmentVariables } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';

export type TitleGenerationResult =
  | { success: true; title: string }
  | { success: false; error: string };

export type TitleGenerationCallback = (
  conversationId: string,
  result: TitleGenerationResult
) => Promise<void>;

export class TitleGenerationService {
  private plugin: GeminianPlugin;
  private activeGenerations: Map<string, AbortController> = new Map();

  constructor(plugin: GeminianPlugin) {
    this.plugin = plugin;
  }

  async generateTitle(
    conversationId: string,
    userMessage: string,
    callback: TitleGenerationCallback
  ): Promise<void> {
    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) {
      await this.safeCallback(callback, conversationId, {
        success: false, error: 'Could not determine vault path',
      });
      return;
    }

    const envVars = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());
    const resolvedGeminiPath = this.plugin.getResolvedGeminiCliPath();
    if (!resolvedGeminiPath) {
      await this.safeCallback(callback, conversationId, {
        success: false, error: 'Gemini CLI not found',
      });
      return;
    }
    const enhancedPath = getEnhancedPath(envVars.PATH, resolvedGeminiPath);

    if (resolvedGeminiPath.endsWith('.js')) {
      const missingNodeError = getMissingNodeError(resolvedGeminiPath, enhancedPath);
      if (missingNodeError) {
        await this.safeCallback(callback, conversationId, {
          success: false, error: missingNodeError,
        });
        return;
      }
    }

    const titleModel =
      this.plugin.settings.titleGenerationModel ||
      envVars.GEMINI_DEFAULT_FLASH_MODEL ||
      'gemini-2.5-flash-lite';

    const existingController = this.activeGenerations.get(conversationId);
    if (existingController) {
      existingController.abort();
    }

    const abortController = new AbortController();
    this.activeGenerations.set(conversationId, abortController);

    const truncatedUser = this.truncateText(userMessage, 500);
    const prompt = `User's request:\n"""\n${truncatedUser}\n"""\n\nGenerate a title for this conversation:`;

    try {
      const promptPath = QueryOptionsBuilder.writeSystemPromptFile(vaultPath, TITLE_GENERATION_SYSTEM_PROMPT);
      const child = spawnGeminiCli({
        cliPath: resolvedGeminiPath,
        args: [
          '--output-format', 'stream-json',
          '--model', titleModel,
          '--approval-mode', 'yolo',
          '--prompt', prompt,
        ],
        cwd: vaultPath,
        env: {
          ...process.env,
          ...envVars,
          PATH: enhancedPath,
          GEMINI_SYSTEM_MD: promptPath,
        },
        signal: abortController.signal,
        enhancedPath,
      });

      let responseText = '';

      if (child.stdout) {
        const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        for await (const line of rl) {
          if (abortController.signal.aborted) break;
          const event = parseGeminiJsonLine(line);
          if (event && event.type === 'message' && event.role === 'assistant') {
            responseText += event.content || '';
          }
        }
      }

      const title = this.parseTitle(responseText);
      if (title) {
        await this.safeCallback(callback, conversationId, { success: true, title });
      } else {
        await this.safeCallback(callback, conversationId, {
          success: false, error: 'Failed to parse title from response',
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      await this.safeCallback(callback, conversationId, { success: false, error: msg });
    } finally {
      this.activeGenerations.delete(conversationId);
    }
  }

  cancel(): void {
    for (const controller of this.activeGenerations.values()) {
      controller.abort();
    }
    this.activeGenerations.clear();
  }

  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  }

  private parseTitle(responseText: string): string | null {
    const trimmed = responseText.trim();
    if (!trimmed) return null;

    let title = trimmed;
    if (
      (title.startsWith('"') && title.endsWith('"')) ||
      (title.startsWith("'") && title.endsWith("'"))
    ) {
      title = title.slice(1, -1);
    }

    title = title.replace(/[.!?:;,]+$/, '');
    if (title.length > 50) {
      title = title.substring(0, 47) + '...';
    }

    return title || null;
  }

  private async safeCallback(
    callback: TitleGenerationCallback,
    conversationId: string,
    result: TitleGenerationResult
  ): Promise<void> {
    try {
      await callback(conversationId, result);
    } catch {
      // Silently ignore callback errors
    }
  }
}
