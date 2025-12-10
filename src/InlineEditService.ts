/**
 * InlineEditService - Lightweight service for inline text editing with Claude
 *
 * Unlike the full ClaudianService which supports agentic workflows with tool use,
 * this service is optimized for simple text transformations:
 * - Focused system prompt (edit text, return only the result)
 * - No conversation history
 */

import { query, type Options, type HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import type ClaudianPlugin from './main';
import { THINKING_BUDGETS } from './types';
import { getTodayDate, getVaultPath, parseEnvironmentVariables } from './utils';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface InlineEditRequest {
  selectedText: string;
  instruction: string;
  notePath: string;
}

export interface InlineEditResult {
  success: boolean;
  editedText?: string;
  clarification?: string;  // Agent asking for clarification
  error?: string;
}

function getInlineEditSystemPrompt(): string {
  return `Today is ${getTodayDate()}.

You are a text assistant embedded in Obsidian. You help users with their selected text - answering questions, making edits, or providing information.

# Input Format

You will receive:
- File: path to the note containing the selection
- Selected text between "---" delimiters
- Request: the user's instruction or question

# Tools Available

You have access to read-only tools for gathering context:
- Read: Read files from the vault (the current note or related files)
- Grep: Search for patterns across files
- Glob: Find files by name pattern
- LS: List directory contents
- WebSearch: Search the web for information
- WebFetch: Fetch and process web content

Proactively use Read to understand the note containing the selection - it often provides crucial background context. If the user mentions other files (e.g., @note.md), use Grep, Glob, or LS to locate them, then Read to understand their content. Use WebSearch or WebFetch when instructed or when external information would help.

# Output Rules - CRITICAL

ABSOLUTE RULE: Your text output must contain ONLY the final answer or replacement. NEVER output:
- "I'll read the file..." / "Let me check..." / "I will..."
- "I'm asked about..." / "The user wants..."
- "Based on my analysis..." / "After reading..."
- "Here's..." / "The answer is..."
- ANY announcement of what you're about to do or did

Use tools silently. Your text output = final result only.

## When Replacing the Selected Text

If the user wants to MODIFY or REPLACE the selected text, wrap the replacement in <replacement> tags:

<replacement>your replacement text here</replacement>

The content inside the tags should be ONLY the replacement text - no explanation.

## When Answering Questions or Providing Information

If the user is asking a QUESTION, respond WITHOUT <replacement> tags. Output the answer directly.

WRONG: "I'll read the full context of this file to give you a better explanation. This is a guide about..."
CORRECT: "This is a guide about..."

## When Clarification is Needed

If the request is ambiguous, ask a clarifying question. Keep questions concise and specific.

# Examples

Input:
File: notes/readme.md
---
Hello world
---
Request: translate to French

CORRECT (replacement):
<replacement>Bonjour le monde</replacement>

Input:
File: notes/code.md
---
const x = arr.reduce((a, b) => a + b, 0);
---
Request: what does this do?

CORRECT (question - no tags):
This code sums all numbers in the array \`arr\`. It uses \`reduce\` to iterate through the array, accumulating the total starting from 0.

Input:
File: notes/draft.md
---
The bank was steep.
---
Request: translate to Spanish

CORRECT (asking for clarification):
"Bank" can mean a financial institution (banco) or a river bank (orilla). Which meaning should I use?

Then after user clarifies "river bank":
<replacement>La orilla era empinada.</replacement>`;
}

// Read-only tools allowed for inline editing
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch'] as const;

export class InlineEditService {
  private plugin: ClaudianPlugin;
  private abortController: AbortController | null = null;
  private resolvedClaudePath: string | null = null;
  private sessionId: string | null = null;  // For conversation continuity

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  /**
   * Reset conversation state (call when starting a new edit)
   */
  resetConversation(): void {
    this.sessionId = null;
  }

  /**
   * Find the claude CLI binary
   */
  private findClaudeCLI(): string | null {
    const homeDir = os.homedir();
    const commonPaths = [
      path.join(homeDir, '.claude', 'local', 'claude'),
      path.join(homeDir, '.local', 'bin', 'claude'),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      path.join(homeDir, 'bin', 'claude'),
    ];

    for (const p of commonPaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    return null;
  }

  /**
   * Edit text according to instructions (initial request)
   */
  async editText(request: InlineEditRequest): Promise<InlineEditResult> {
    // Reset session for new edit
    this.sessionId = null;
    const prompt = this.buildPrompt(request);
    return this.sendMessage(prompt);
  }

  /**
   * Continue conversation with a follow-up message
   */
  async continueConversation(message: string): Promise<InlineEditResult> {
    if (!this.sessionId) {
      return { success: false, error: 'No active conversation to continue' };
    }
    return this.sendMessage(message);
  }

  /**
   * Send a message (initial or follow-up)
   */
  private async sendMessage(prompt: string): Promise<InlineEditResult> {
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
      systemPrompt: getInlineEditSystemPrompt(),
      model: this.plugin.settings.model,
      abortController: this.abortController,
      pathToClaudeCodeExecutable: this.resolvedClaudePath,
      env: {
        ...process.env,
        ...customEnv,
      },
      // Restrict to read-only tools
      allowedTools: [...READ_ONLY_TOOLS],
      // Bypass permissions for allowed read-only tools
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      // Safety net: PreToolUse hook to block any write tools that slip through
      hooks: {
        PreToolUse: [this.createReadOnlyHook()],
      },
    };

    // Resume session if continuing conversation
    if (this.sessionId) {
      options.resume = this.sessionId;
    }

    // Enable thinking if configured
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

        // Capture session ID from init message
        if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
          this.sessionId = message.session_id;
        }

        // Extract text from message
        const text = this.extractTextFromMessage(message);
        if (text) {
          responseText += text;
        }
      }

      // Parse response for <replacement> tag
      return this.parseResponse(responseText);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: msg };
    } finally {
      this.abortController = null;
    }
  }

  /**
   * Parse response text for <replacement> tag
   */
  private parseResponse(responseText: string): InlineEditResult {
    // Check for <replacement> tag
    const match = responseText.match(/<replacement>([\s\S]*?)<\/replacement>/);

    if (match) {
      // Found replacement text - will trigger diff view
      return {
        success: true,
        editedText: match[1],
      };
    }

    // No replacement tag - treat as conversational response (answer or clarification)
    const trimmed = responseText.trim();
    if (trimmed) {
      return {
        success: true,
        clarification: trimmed,
      };
    }

    return { success: false, error: 'Empty response' };
  }

  /**
   * Build the prompt for inline request
   */
  private buildPrompt(request: InlineEditRequest): string {
    return [
      `File: ${request.notePath}`,
      '',
      '---',
      request.selectedText,
      '---',
      '',
      `Request: ${request.instruction}`,
    ].join('\n');
  }

  /**
   * Create PreToolUse hook to enforce read-only mode
   * Safety net in case allowedTools is bypassed (SDK bug #361)
   */
  private createReadOnlyHook(): HookCallbackMatcher {
    return {
      hooks: [
        async (hookInput) => {
          const input = hookInput as {
            tool_name: string;
            tool_input: Record<string, unknown>;
          };
          const toolName = input.tool_name;

          // Allow only read-only tools
          if (READ_ONLY_TOOLS.includes(toolName as typeof READ_ONLY_TOOLS[number])) {
            return { continue: true };
          }

          // Block all other tools
          return {
            continue: false,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'deny' as const,
              permissionDecisionReason: `Inline edit mode: tool "${toolName}" is not allowed (read-only)`,
            },
          };
        },
      ],
    };
  }

  /**
   * Extract text content from SDK message
   */
  private extractTextFromMessage(message: any): string | null {
    if (message.type === 'assistant' && message.message?.content) {
      for (const block of message.message.content) {
        if (block.type === 'text' && block.text) {
          return block.text;
        }
      }
    }

    if (message.type === 'stream_event') {
      const event = message.event;
      if (event?.type === 'content_block_start' && event.content_block?.type === 'text') {
        return event.content_block.text || null;
      }
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        return event.delta.text || null;
      }
    }

    return null;
  }

  /**
   * Cancel the current edit operation
   */
  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }
}
