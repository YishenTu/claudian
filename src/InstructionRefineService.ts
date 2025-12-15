/**
 * Claudian - Instruction refine service
 *
 * Lightweight Claude query service for refining user instructions.
 * Uses read-only tools and parses <instruction> tags from response.
 */

import { query, type Options, type HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import type ClaudianPlugin from './main';
import { type InstructionRefineResult, THINKING_BUDGETS } from './types';
import { getVaultPath, parseEnvironmentVariables, findClaudeCLIPath, isPathWithinVault as isPathWithinVaultUtil } from './utils';

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'] as const;

/** Builds the system prompt for instruction refinement, including existing instructions. */
function buildRefineSystemPrompt(existingInstructions: string): string {
  const existingSection = existingInstructions.trim()
    ? `\n\nEXISTING INSTRUCTIONS (already in the user's system prompt):
\`\`\`
${existingInstructions.trim()}
\`\`\`

When refining the new instruction:
- Consider how it fits with existing instructions
- Avoid duplicating existing instructions
- If the new instruction conflicts with an existing one, refine it to be complementary or note the conflict
- Match the format of existing instructions (section, heading, bullet points, style, etc.)`
    : '';

  return `You are helping refine a custom instruction for an AI assistant.

The user wants to add a new instruction to guide the assistant's behavior in future conversations.
Your task is to:
1. Understand the user's intent
2. Refine the instruction(s) to be clear, specific, and actionable
3. Return a ready-to-append Markdown snippet in <instruction> tags

Guidelines:
- Output should be valid Markdown that can be appended to the user's custom system prompt AS-IS
- You may output a single bullet, multiple bullets, or a small section (e.g., "## Section" + bullets) when grouping is helpful
- Prefer the smallest change that achieves the user's intent
- Make instructions specific and actionable
- Avoid redundancy with common AI assistant behavior
- Preserve the user's intent
- Do not include a "# Custom Instructions" top-level header (it is already present)

If the user's input is unclear or ambiguous, ask a clarifying question (without <instruction> tags).${existingSection}

Examples:

Input: "typescript for code"
Output: <instruction>- Always use TypeScript when providing code examples. Include proper type annotations and interfaces.</instruction>

Input: "be concise"
Output: <instruction>- Provide concise responses. Avoid unnecessary explanations unless specifically requested.</instruction>

Input: "organize coding style rules"
Output: <instruction>## Coding Style\n\n- Use TypeScript for code examples.\n- Prefer small, reviewable diffs and avoid large refactors.</instruction>

Input: "use that thing from before"
Output: I'm not sure what you're referring to. Could you please clarify what "that thing" is that you'd like me to use in future responses?`;
}

/** Callback for streaming progress updates. */
export type RefineProgressCallback = (update: InstructionRefineResult) => void;

/** Service for refining user instructions with Claude. */
export class InstructionRefineService {
  private plugin: ClaudianPlugin;
  private abortController: AbortController | null = null;
  private resolvedClaudePath: string | null = null;
  private sessionId: string | null = null;
  private existingInstructions: string = '';

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  /** Resets conversation state for a new refinement session. */
  resetConversation(): void {
    this.sessionId = null;
  }

  private findClaudeCLI(): string | null {
    return findClaudeCLIPath();
  }

  /** Refines a raw instruction from user input. */
  async refineInstruction(
    rawInstruction: string,
    existingInstructions: string,
    onProgress?: RefineProgressCallback
  ): Promise<InstructionRefineResult> {
    this.sessionId = null;
    this.existingInstructions = existingInstructions;
    const prompt = `Please refine this instruction: "${rawInstruction}"`;
    return this.sendMessage(prompt, onProgress);
  }

  /** Continues conversation with a follow-up message (for clarifications). */
  async continueConversation(
    message: string,
    onProgress?: RefineProgressCallback
  ): Promise<InstructionRefineResult> {
    if (!this.sessionId) {
      return { success: false, error: 'No active conversation to continue' };
    }
    return this.sendMessage(message, onProgress);
  }

  /** Cancels any ongoing query. */
  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  private async sendMessage(
    prompt: string,
    onProgress?: RefineProgressCallback
  ): Promise<InstructionRefineResult> {
    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) {
      return { success: false, error: 'Could not determine vault path' };
    }

    if (!this.resolvedClaudePath) {
      this.resolvedClaudePath = this.findClaudeCLI();
    }

    if (!this.resolvedClaudePath) {
      return { success: false, error: 'Claude CLI not found. Please install Claude Code CLI.' };
    }

    this.abortController = new AbortController();

    // Parse custom environment variables
    const customEnv = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());

    const options: Options = {
      cwd: vaultPath,
      systemPrompt: buildRefineSystemPrompt(this.existingInstructions),
      model: this.plugin.settings.model,
      abortController: this.abortController,
      pathToClaudeCodeExecutable: this.resolvedClaudePath,
      env: {
        ...process.env,
        ...customEnv,
      },
      allowedTools: [...READ_ONLY_TOOLS],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      hooks: {
        PreToolUse: [
          this.createReadOnlyHook(),
          this.createVaultRestrictionHook(vaultPath),
        ],
      },
    };

    if (this.sessionId) {
      options.resume = this.sessionId;
    }

    const budgetSetting = this.plugin.settings.thinkingBudget;
    const budgetConfig = THINKING_BUDGETS.find(b => b.value === budgetSetting);
    if (budgetConfig && budgetConfig.tokens > 0) {
      options.maxThinkingTokens = budgetConfig.tokens;
    }

    try {
      const response = query({ prompt, options });
      let responseText = '';

      for await (const message of response) {
        if (this.abortController?.signal.aborted) {
          await response.interrupt();
          return { success: false, error: 'Cancelled' };
        }

        if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
          this.sessionId = message.session_id;
        }

        const text = this.extractTextFromMessage(message);
        if (text) {
          responseText += text;
          // Stream progress updates
          if (onProgress) {
            const partialResult = this.parseResponse(responseText);
            onProgress(partialResult);
          }
        }
      }

      return this.parseResponse(responseText);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: msg };
    } finally {
      this.abortController = null;
    }
  }

  /** Parses response text for <instruction> tag. */
  private parseResponse(responseText: string): InstructionRefineResult {
    const instructionMatch = responseText.match(/<instruction>([\s\S]*?)<\/instruction>/);
    if (instructionMatch) {
      return { success: true, refinedInstruction: instructionMatch[1].trim() };
    }

    // No instruction tag - treat as clarification question
    const trimmed = responseText.trim();
    if (trimmed) {
      return { success: true, clarification: trimmed };
    }

    return { success: false, error: 'Empty response' };
  }

  /** Extracts text content from SDK message. */
  private extractTextFromMessage(message: { type: string; message?: { content?: Array<{ type: string; text?: string }> } }): string {
    if (message.type !== 'assistant' || !message.message?.content) {
      return '';
    }

    return message.message.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && !!block.text)
      .map(block => block.text)
      .join('');
  }

  /** Creates PreToolUse hook to enforce read-only mode. */
  private createReadOnlyHook(): HookCallbackMatcher {
    return {
      hooks: [
        async (hookInput) => {
          const input = hookInput as {
            tool_name: string;
            tool_input: Record<string, unknown>;
          };
          const toolName = input.tool_name;

          if (READ_ONLY_TOOLS.includes(toolName as typeof READ_ONLY_TOOLS[number])) {
            return { continue: true };
          }

          return {
            continue: false,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'deny' as const,
              permissionDecisionReason: `Instruction refine mode: tool "${toolName}" is not allowed (read-only)`,
            },
          };
        },
      ],
    };
  }

  /** Creates PreToolUse hook to restrict file access to vault. */
  private createVaultRestrictionHook(vaultPath: string): HookCallbackMatcher {
    return {
      hooks: [
        async (hookInput) => {
          const input = hookInput as {
            tool_name: string;
            tool_input: Record<string, unknown>;
          };
          const toolName = input.tool_name;
          const toolInput = input.tool_input;

          // Check file path tools
          if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') {
            const filePath =
              toolName === 'Read'
                ? ((toolInput.file_path as string) || '')
                : (((toolInput.path as string) || (toolInput.pattern as string)) || '');
            if (filePath && !isPathWithinVaultUtil(filePath, vaultPath)) {
              return {
                continue: false,
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse' as const,
                  permissionDecision: 'deny' as const,
                  permissionDecisionReason: `Access denied: "${filePath}" is outside the vault`,
                },
              };
            }
          }

          return { continue: true };
        },
      ],
    };
  }
}
