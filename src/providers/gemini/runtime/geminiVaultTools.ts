import { SchemaType, type FunctionDeclaration } from '@google/generative-ai';
import { normalizePath } from 'obsidian';

import type ClaudianPlugin from '../../../main';

const MAX_FILE_CHARS = 100_000;
const MAX_SEARCH_RESULTS = 30;

export const GEMINI_VAULT_WRITE_TOOLS = new Set(['write_file', 'edit_file']);

export const GEMINI_VAULT_TOOLS: FunctionDeclaration[] = [
  {
    name: 'list_files',
    description: 'List files and folders in the vault. Paths are vault-relative. Omit path to list the vault root.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        path: { type: SchemaType.STRING, description: 'Vault-relative folder path, e.g. "Notes/Projects". Omit for the vault root.' },
      },
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file in the vault.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        path: { type: SchemaType.STRING, description: 'Vault-relative file path, e.g. "Notes/Idea.md".' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create a new file or overwrite an existing file in the vault with the given content.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        path: { type: SchemaType.STRING, description: 'Vault-relative file path, e.g. "Notes/New note.md".' },
        content: { type: SchemaType.STRING, description: 'Full file content to write.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Edit a file by replacing an exact text fragment. The old_string must appear exactly once in the file.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        path: { type: SchemaType.STRING, description: 'Vault-relative file path.' },
        old_string: { type: SchemaType.STRING, description: 'Exact existing text to replace (must be unique in the file).' },
        new_string: { type: SchemaType.STRING, description: 'Replacement text.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'search_notes',
    description: 'Search markdown notes in the vault by file name and content. Returns matching file paths with a short snippet.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: { type: SchemaType.STRING, description: 'Text to search for (case-insensitive).' },
      },
      required: ['query'],
    },
  },
];

const VAULT_TOOL_NAMES = new Set(GEMINI_VAULT_TOOLS.map((tool) => tool.name));

export function isGeminiVaultTool(name: string): boolean {
  return VAULT_TOOL_NAMES.has(name);
}

export interface VaultToolResult {
  content: string;
  isError: boolean;
}

function ok(content: string): VaultToolResult {
  return { content, isError: false };
}

function fail(content: string): VaultToolResult {
  return { content, isError: true };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function ensureParentFolders(plugin: ClaudianPlugin, filePath: string): Promise<void> {
  const adapter = plugin.app.vault.adapter;
  const parts = filePath.split('/').slice(0, -1);
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!(await adapter.exists(current))) {
      await adapter.mkdir(current);
    }
  }
}

export async function executeGeminiVaultTool(
  plugin: ClaudianPlugin,
  name: string,
  args: Record<string, unknown>,
): Promise<VaultToolResult> {
  const adapter = plugin.app.vault.adapter;

  try {
    switch (name) {
      case 'list_files': {
        const raw = asString(args.path).trim();
        const target = raw ? normalizePath(raw) : '/';
        if (target !== '/' && !(await adapter.exists(target))) {
          return fail(`Folder not found: ${target}`);
        }
        const listing = await adapter.list(target);
        const lines = [
          ...listing.folders.map((f) => `${f}/`),
          ...listing.files,
        ];
        return ok(lines.length > 0 ? lines.join('\n') : '(empty folder)');
      }

      case 'read_file': {
        const path = normalizePath(asString(args.path));
        if (!(await adapter.exists(path))) {
          return fail(`File not found: ${path}`);
        }
        const content = await adapter.read(path);
        if (content.length > MAX_FILE_CHARS) {
          return ok(`${content.slice(0, MAX_FILE_CHARS)}\n\n[... truncated, file has ${content.length} characters total]`);
        }
        return ok(content);
      }

      case 'write_file': {
        const path = normalizePath(asString(args.path));
        if (!path) {
          return fail('Path is required.');
        }
        await ensureParentFolders(plugin, path);
        await adapter.write(path, asString(args.content));
        return ok(`File written: ${path}`);
      }

      case 'edit_file': {
        const path = normalizePath(asString(args.path));
        const oldString = asString(args.old_string);
        const newString = asString(args.new_string);
        if (!(await adapter.exists(path))) {
          return fail(`File not found: ${path}`);
        }
        if (!oldString) {
          return fail('old_string is required.');
        }
        const content = await adapter.read(path);
        const occurrences = content.split(oldString).length - 1;
        if (occurrences === 0) {
          return fail('old_string not found in the file. Read the file first and copy the exact text.');
        }
        if (occurrences > 1) {
          return fail(`old_string appears ${occurrences} times; include more surrounding context to make it unique.`);
        }
        await adapter.write(path, content.replace(oldString, newString));
        return ok(`File edited: ${path}`);
      }

      case 'search_notes': {
        const query = asString(args.query).trim().toLowerCase();
        if (!query) {
          return fail('query is required.');
        }
        const files = plugin.app.vault.getMarkdownFiles();
        const results: string[] = [];

        for (const file of files) {
          if (results.length >= MAX_SEARCH_RESULTS) break;
          if (file.path.toLowerCase().includes(query)) {
            results.push(file.path);
            continue;
          }
          const content = await plugin.app.vault.cachedRead(file);
          const index = content.toLowerCase().indexOf(query);
          if (index !== -1) {
            const snippet = content
              .slice(Math.max(0, index - 60), index + query.length + 60)
              .replace(/\s+/g, ' ')
              .trim();
            results.push(`${file.path} — "...${snippet}..."`);
          }
        }

        return ok(results.length > 0 ? results.join('\n') : 'No matches found.');
      }

      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
