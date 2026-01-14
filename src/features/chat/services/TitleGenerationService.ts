/**
 * Claudian - Title generation service
 *
 * Lightweight Claude query service for generating conversation titles
 * based on first user message and first AI response.
 */

import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { query as agentQuery } from '@anthropic-ai/claude-agent-sdk';

import { TITLE_GENERATION_SYSTEM_PROMPT } from '../../../core/prompts/titleGeneration';
import type ClaudianPlugin from '../../../main';
import { getEnhancedPath, parseEnvironmentVariables } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';

/** Result of title generation (discriminated union). */
export type TitleGenerationResult =
  | { success: true; title: string }
  | { success: false; error: string };

/** Callback when title generation completes. */
export type TitleGenerationCallback = (
  conversationId: string,
  result: TitleGenerationResult
) => Promise<void>;

/** Service for generating conversation titles with AI. */
export class TitleGenerationService {
  private plugin: ClaudianPlugin;
  /** Map of conversationId to AbortController for concurrent generation support. */
  private activeGenerations: Map<string, AbortController> = new Map();

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  /**
   * Generates a title for a conversation based on first messages.
   * Non-blocking: calls callback when complete.
   */
  async generateTitle(
    conversationId: string,
    userMessage: string,
    assistantResponse: string,
    callback: TitleGenerationCallback
  ): Promise<void> {
    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) {
      await this.safeCallback(callback, conversationId, {
        success: false,
        error: 'Could not determine vault path',
      });
      return;
    }

    const envVars = parseEnvironmentVariables(
      this.plugin.getActiveEnvironmentVariables()
    );

    const resolvedClaudePath = this.plugin.getResolvedClaudeCliPath();
    if (!resolvedClaudePath) {
      await this.safeCallback(callback, conversationId, {
        success: false,
        error: 'Claude CLI not found',
      });
      return;
    }

    // Get the appropriate model with fallback chain:
    // 1. User's titleGenerationModel setting (if set)
    // 2. ANTHROPIC_DEFAULT_HAIKU_MODEL env var
    // 3. claude-haiku-4-5 default
    const titleModel =
      this.plugin.settings.titleGenerationModel ||
      envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL ||
      'claude-haiku-4-5';

    // Cancel any existing generation for this conversation
    const existingController = this.activeGenerations.get(conversationId);
    if (existingController) {
      existingController.abort();
    }

    // Create a new local AbortController for this generation
    const abortController = new AbortController();
    this.activeGenerations.set(conversationId, abortController);

    // Truncate messages if too long (save tokens)
    const truncatedUser = this.truncateText(userMessage, 500);
    const truncatedAssistant = this.truncateText(assistantResponse, 500);

    const prompt = `User's first message:
"""
${truncatedUser}
"""

AI's response:
"""
${truncatedAssistant}
"""

Generate a title for this conversation:`;

    const options: Options = {
      cwd: vaultPath,
      systemPrompt: TITLE_GENERATION_SYSTEM_PROMPT,
      model: titleModel,
      abortController,
      pathToClaudeCodeExecutable: resolvedClaudePath,
      env: {
        ...process.env,
        ...envVars,
        PATH: getEnhancedPath(envVars.PATH, resolvedClaudePath),
      },
      tools: [], // No tools needed for title generation
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      persistSession: false, // Don't save title generation queries to session history
    };

    try {
      const response = agentQuery({ prompt, options });
      let responseText = '';

      for await (const message of response) {
        if (abortController.signal.aborted) {
          await this.safeCallback(callback, conversationId, {
            success: false,
            error: 'Cancelled',
          });
          return;
        }

        const text = this.extractTextFromMessage(message);
        if (text) {
          responseText += text;
        }
      }

      const title = this.parseTitle(responseText);
      if (title) {
        await this.safeCallback(callback, conversationId, { success: true, title });
      } else {
        await this.safeCallback(callback, conversationId, {
          success: false,
          error: 'Failed to parse title from response',
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      await this.safeCallback(callback, conversationId, { success: false, error: msg });
    } finally {
      // Clean up the controller for this conversation
      this.activeGenerations.delete(conversationId);
    }
  }

  /** Cancels all ongoing title generations. */
  cancel(): void {
    for (const controller of this.activeGenerations.values()) {
      controller.abort();
    }
    this.activeGenerations.clear();
  }

  /** Truncates text to a maximum length with ellipsis. */
  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  }

  /** Extracts text content from SDK message. */
  private extractTextFromMessage(
    message: { type: string; message?: { content?: Array<{ type: string; text?: string }> } }
  ): string {
    if (message.type !== 'assistant' || !message.message?.content) {
      return '';
    }

    return message.message.content
      .filter((block): block is { type: 'text'; text: string } =>
        block.type === 'text' && !!block.text
      )
      .map((block) => block.text)
      .join('');
  }

  /** Parses and cleans the title from response. */
  private parseTitle(responseText: string): string | null {
    const trimmed = responseText.trim();
    if (!trimmed) return null;

    // Remove surrounding quotes if present
    let title = trimmed;
    if (
      (title.startsWith('"') && title.endsWith('"')) ||
      (title.startsWith("'") && title.endsWith("'"))
    ) {
      title = title.slice(1, -1);
    }

    // Remove trailing punctuation
    title = title.replace(/[.!?:;,]+$/, '');

    // Truncate to max 50 characters
    if (title.length > 50) {
      title = title.substring(0, 47) + '...';
    }

    return title || null;
  }

  /** Safely invokes callback with try-catch to prevent unhandled errors. */
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
