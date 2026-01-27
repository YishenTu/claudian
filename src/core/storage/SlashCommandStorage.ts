import { parsedToSlashCommand, parseSlashCommandContent, serializeCommand } from '../../utils/slashCommand';
import type { SlashCommand } from '../types';
import type { VaultFileAdapter } from './VaultFileAdapter';

export const COMMANDS_PATH = '.claude/commands';

export class SlashCommandStorage {
  constructor(private adapter: VaultFileAdapter) {}

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
          // Non-critical: skip malformed command files
        }
      }
    } catch {
      // Non-critical: directory may not exist yet
    }

    return commands;
  }

  private async loadFromFile(filePath: string): Promise<SlashCommand | null> {
    try {
      const content = await this.adapter.read(filePath);
      return this.parseFile(content, filePath);
    } catch {
      return null;
    }
  }

  async save(command: SlashCommand): Promise<void> {
    const filePath = this.getFilePath(command);
    await this.adapter.write(filePath, serializeCommand(command));
  }

  async delete(commandId: string): Promise<void> {
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

  getFilePath(command: SlashCommand): string {
    const safeName = command.name.replace(/[^a-zA-Z0-9_/-]/g, '-');
    return `${COMMANDS_PATH}/${safeName}.md`;
  }

  private parseFile(content: string, filePath: string): SlashCommand {
    const parsed = parseSlashCommandContent(content);
    return parsedToSlashCommand(parsed, {
      id: this.filePathToId(filePath),
      name: this.filePathToName(filePath),
    });
  }

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

  private filePathToName(filePath: string): string {
    return filePath
      .replace(`${COMMANDS_PATH}/`, '')
      .replace(/\.md$/, '');
  }
}
