/**
 * SlashCommandStorage - Handles slash command files in vault/.claude/commands/
 *
 * Each command is stored as a Markdown file with YAML frontmatter.
 * Supports nested folders for organization.
 *
 * File format:
 * ```markdown
 * ---
 * description: Review code for issues
 * argument-hint: "[file] [focus]"
 * allowed-tools:
 *   - Read
 *   - Grep
 * model: claude-sonnet-4-5
 * ---
 * Your prompt content here with $ARGUMENTS placeholder
 * ```
 */

import { parseSlashCommandContent } from '../../utils/slashCommand';
import type { ClaudeModel, SlashCommand } from '../types';
import type { VaultFileAdapter } from './VaultFileAdapter';

/** Path to commands folder relative to vault root. */
export const COMMANDS_PATH = '.claude/commands';

export class SlashCommandStorage {
  constructor(private adapter: VaultFileAdapter) {}

  /** Load all commands from .claude/commands/ recursively. */
  async loadAll(): Promise<SlashCommand[]> {
    const commands: SlashCommand[] = [];

    try {
      const files = await this.adapter.listFilesRecursive(COMMANDS_PATH);

      for (const filePath of files) {
        if (!filePath.endsWith('.md')) continue;

        try {
          const command = await this.loadFromFile(filePath);
          if (command) {
            commands.push(command);
          }
        } catch {
          // Skip commands that fail to load
        }
      }
    } catch {
      // Return empty list if directory listing fails
    }

    return commands;
  }

  /** Load a single command from a file path. */
  async loadFromFile(filePath: string): Promise<SlashCommand | null> {
    try {
      const content = await this.adapter.read(filePath);
      return this.parseFile(content, filePath);
    } catch {
      return null;
    }
  }

  /** Save a command to its file. */
  async save(command: SlashCommand): Promise<void> {
    const filePath = this.getFilePath(command);
    const content = this.serializeCommand(command);
    await this.adapter.write(filePath, content);
  }

  /** Delete a command file by ID. */
  async delete(commandId: string): Promise<void> {
    // Find the file by listing and matching ID
    const files = await this.adapter.listFilesRecursive(COMMANDS_PATH);

    for (const filePath of files) {
      if (!filePath.endsWith('.md')) continue;

      const id = this.filePathToId(filePath);
      if (id === commandId) {
        await this.adapter.delete(filePath);
        return;
      }
    }
  }

  /** Check if any commands exist. */
  async hasCommands(): Promise<boolean> {
    const files = await this.adapter.listFilesRecursive(COMMANDS_PATH);
    return files.some(f => f.endsWith('.md'));
  }

  /** Get the file path for a command. */
  getFilePath(command: SlashCommand): string {
    // Convert command name to file path
    // e.g., "review-code" -> ".claude/commands/review-code.md"
    // For nested commands, use slashes: "code/refactor" -> ".claude/commands/code/refactor.md"
    const safeName = command.name.replace(/[^a-zA-Z0-9_/-]/g, '-');
    return `${COMMANDS_PATH}/${safeName}.md`;
  }

  /** Parse a command file into a SlashCommand object. */
  parseFile(content: string, filePath: string): SlashCommand {
    const parsed = parseSlashCommandContent(content);
    const id = this.filePathToId(filePath);
    const name = this.filePathToName(filePath);

    return {
      id,
      name,
      description: parsed.description,
      argumentHint: parsed.argumentHint,
      allowedTools: parsed.allowedTools,
      model: parsed.model as ClaudeModel | undefined,
      content: parsed.promptContent,
    };
  }

  /** Convert a file path to a command ID (reversible encoding). */
  private filePathToId(filePath: string): string {
    // Encoding: escape `-` as `-_`, then replace `/` with `--`
    // This is unambiguous and reversible:
    //   a/b.md   -> cmd-a--b
    //   a-b.md   -> cmd-a-_b
    //   a--b.md  -> cmd-a-_-_b
    //   a/b-c.md -> cmd-a--b-_c
    const relativePath = filePath
      .replace(`${COMMANDS_PATH}/`, '')
      .replace(/\.md$/, '');
    const escaped = relativePath
      .replace(/-/g, '-_')   // Escape dashes first
      .replace(/\//g, '--'); // Then encode slashes
    return `cmd-${escaped}`;
  }

  /** Convert a file path to a command name. */
  private filePathToName(filePath: string): string {
    // .claude/commands/nested/foo.md -> nested/foo
    return filePath
      .replace(`${COMMANDS_PATH}/`, '')
      .replace(/\.md$/, '');
  }

  /** Serialize a command to Markdown with YAML frontmatter. */
  private serializeCommand(command: SlashCommand): string {
    const lines: string[] = ['---'];

    if (command.description) {
      lines.push(`description: ${this.yamlString(command.description)}`);
    }
    if (command.argumentHint) {
      lines.push(`argument-hint: ${this.yamlString(command.argumentHint)}`);
    }
    if (command.allowedTools && command.allowedTools.length > 0) {
      lines.push('allowed-tools:');
      for (const tool of command.allowedTools) {
        lines.push(`  - ${tool}`);
      }
    }
    if (command.model) {
      lines.push(`model: ${command.model}`);
    }

    // Ensure at least one blank line between --- markers when no metadata exists
    // (the frontmatter regex requires \n before the closing ---)
    if (lines.length === 1) {
      lines.push('');
    }

    lines.push('---');

    // Extract prompt content (strip existing frontmatter if present)
    const parsed = parseSlashCommandContent(command.content);
    lines.push(parsed.promptContent);

    return lines.join('\n');
  }

  /** Quote a YAML string if needed. */
  private yamlString(value: string): string {
    if (value.includes(':') || value.includes('#') || value.includes('\n') ||
        value.startsWith(' ') || value.endsWith(' ')) {
      return `"${value.replace(/"/g, '\\"')}"`;
    }
    return value;
  }
}
