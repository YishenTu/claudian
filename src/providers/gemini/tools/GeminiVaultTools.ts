import { normalizePath, TFile, TFolder } from 'obsidian';

import type ClaudianPlugin from '../../../main';
import type { GeminiFunctionDeclaration } from '../runtime/GeminiApiClient';

export interface GeminiToolExecutionResult {
  content: string;
  isError?: boolean;
}

const MAX_FILE_READ_CHARS = 80_000;
const DEFAULT_MAX_RESULTS = 200;

export const GEMINI_VAULT_TOOL_APPENDIX = `## Gemini Provider Tools

This Gemini API provider exposes Obsidian vault tools for reading and writing text/markdown notes. Use these tools when you need vault context not already supplied in the user message, or when the user explicitly asks you to create or edit notes. All paths must be relative to the vault root. Hidden/system folders are intentionally excluded from these tools for safety. Write tools should be used carefully and only when the user asks for a vault change.

No image-generation or binary-file-generation tool is currently available in this Gemini provider. If the user asks you to draw, generate, create, or insert an image asset, do not fabricate markdown image links, broken placeholder image syntax, or claim that an image file was created. Instead, either create a text-only/ASCII sketch or written image description in a note if that satisfies the request, or clearly say that Gemini image generation is not wired into Claudian yet.`;

export const GEMINI_VAULT_TOOL_DECLARATIONS: GeminiFunctionDeclaration[] = [
  {
    name: 'list_vault_files',
    description: 'List markdown files under a vault folder. Hidden/system folders are excluded.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Folder path relative to the vault root. Use "." for the vault root.',
        },
        recursive: {
          type: 'boolean',
          description: 'Whether to include files in nested folders.',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of file paths to return. Default 200.',
        },
      },
    },
  },
  {
    name: 'read_vault_file',
    description: 'Read a markdown/text file from the vault. Hidden/system folders are excluded.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to the vault root.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_vault_files',
    description: 'Search markdown file paths by a case-insensitive substring.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Substring to search for in file paths.',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of file paths to return. Default 200.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'grep_vault',
    description: 'Search text file contents for a case-insensitive substring. Returns matching file paths and line previews.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Substring to search for in file contents.',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of matches to return. Default 50.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'write_vault_file',
    description: 'Create a new text/markdown file, or overwrite an existing file only when overwrite is true. Hidden/system folders are excluded.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to the vault root.',
        },
        content: {
          type: 'string',
          description: 'Complete file contents to write.',
        },
        overwrite: {
          type: 'boolean',
          description: 'Set true to overwrite an existing file. Defaults to false.',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'append_vault_file',
    description: 'Append text to an existing text/markdown file. Can create the file when createIfMissing is true. Hidden/system folders are excluded.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to the vault root.',
        },
        content: {
          type: 'string',
          description: 'Text to append.',
        },
        createIfMissing: {
          type: 'boolean',
          description: 'Create the file if it does not exist. Defaults to true.',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'replace_in_vault_file',
    description: 'Replace exact text in an existing text/markdown file. Hidden/system folders are excluded.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to the vault root.',
        },
        search: {
          type: 'string',
          description: 'Exact text to find.',
        },
        replacement: {
          type: 'string',
          description: 'Replacement text.',
        },
        replaceAll: {
          type: 'boolean',
          description: 'Replace every exact match. Defaults to false.',
        },
      },
      required: ['path', 'search', 'replacement'],
    },
  },
  {
    name: 'create_vault_folder',
    description: 'Create a folder in the vault, including missing parent folders. Hidden/system folders are excluded.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Folder path relative to the vault root.',
        },
      },
      required: ['path'],
    },
  },
];

export const GEMINI_WRITE_TOOL_NAMES = new Set([
  'write_vault_file',
  'append_vault_file',
  'replace_in_vault_file',
  'create_vault_folder',
]);

export function isGeminiWriteTool(name: string): boolean {
  return GEMINI_WRITE_TOOL_NAMES.has(name);
}

export function describeGeminiWriteTool(
  name: string,
  input: Record<string, unknown>,
): string {
  const path = typeof input.path === 'string' ? input.path : '(missing path)';
  switch (name) {
    case 'write_vault_file':
      return input.overwrite === true
        ? `Overwrite vault file: ${path}`
        : `Create vault file: ${path}`;
    case 'append_vault_file':
      return `Append to vault file: ${path}`;
    case 'replace_in_vault_file':
      return `Replace text in vault file: ${path}`;
    case 'create_vault_folder':
      return `Create vault folder: ${path}`;
    default:
      return `Modify vault path: ${path}`;
  }
}

function isBlockedPath(path: string): boolean {
  const normalized = normalizePath(path || '.');
  if (normalized === '.') return false;
  if (normalized.startsWith('/') || normalized.includes('..')) return true;
  return normalized
    .split('/')
    .some(part => part.startsWith('.'));
}

function normalizeVaultPath(value: unknown): string {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : '.';
  return normalizePath(raw);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function validateWritablePath(path: string): string | null {
  if (!path || path === '.') {
    return 'Path must be a file or folder path relative to the vault root.';
  }
  if (isBlockedPath(path)) {
    return `Blocked system path: ${path}`;
  }
  return null;
}

function normalizeMaxResults(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(1000, Math.floor(value)));
}

function getReadableTextFiles(plugin: ClaudianPlugin): TFile[] {
  return plugin.app.vault.getFiles()
    .filter(file => !isBlockedPath(file.path))
    .filter(file => /\.(md|txt|json|yaml|yml|csv|ts|tsx|js|jsx|css|scss|html|xml)$/i.test(file.path));
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export async function executeGeminiVaultTool(
  plugin: ClaudianPlugin,
  name: string,
  input: Record<string, unknown>,
): Promise<GeminiToolExecutionResult> {
  try {
    switch (name) {
      case 'list_vault_files':
        return listVaultFiles(plugin, input);
      case 'read_vault_file':
        return readVaultFile(plugin, input);
      case 'search_vault_files':
        return searchVaultFiles(plugin, input);
      case 'grep_vault':
        return grepVault(plugin, input);
      case 'write_vault_file':
        return writeVaultFile(plugin, input);
      case 'append_vault_file':
        return appendVaultFile(plugin, input);
      case 'replace_in_vault_file':
        return replaceInVaultFile(plugin, input);
      case 'create_vault_folder':
        return createVaultFolder(plugin, input);
      default:
        return { content: `Unknown Gemini tool: ${name}`, isError: true };
    }
  } catch (error) {
    return {
      content: error instanceof Error ? error.message : String(error),
      isError: true,
    };
  }
}

async function listVaultFiles(
  plugin: ClaudianPlugin,
  input: Record<string, unknown>,
): Promise<GeminiToolExecutionResult> {
  const folder = normalizeVaultPath(input.path);
  const recursive = input.recursive === true;
  const maxResults = normalizeMaxResults(input.maxResults, DEFAULT_MAX_RESULTS);

  if (isBlockedPath(folder)) {
    return { content: `Blocked system path: ${folder}`, isError: true };
  }

  const prefix = folder === '.' ? '' : `${folder.replace(/\/$/, '')}/`;
  const files = getReadableTextFiles(plugin)
    .map(file => file.path)
    .filter(path => {
      if (!prefix) return true;
      if (!path.startsWith(prefix)) return false;
      if (recursive) return true;
      return !path.slice(prefix.length).includes('/');
    })
    .slice(0, maxResults);

  return { content: formatJson({ files, truncated: files.length >= maxResults }) };
}

async function readVaultFile(
  plugin: ClaudianPlugin,
  input: Record<string, unknown>,
): Promise<GeminiToolExecutionResult> {
  const path = normalizeVaultPath(input.path);
  if (isBlockedPath(path)) {
    return { content: `Blocked system path: ${path}`, isError: true };
  }

  const file = plugin.app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) {
    return { content: `File not found: ${path}`, isError: true };
  }

  const content = await plugin.app.vault.read(file);
  const truncated = content.length > MAX_FILE_READ_CHARS;
  return {
    content: formatJson({
      path,
      content: truncated ? content.slice(0, MAX_FILE_READ_CHARS) : content,
      truncated,
    }),
  };
}

async function searchVaultFiles(
  plugin: ClaudianPlugin,
  input: Record<string, unknown>,
): Promise<GeminiToolExecutionResult> {
  const query = typeof input.query === 'string' ? input.query.trim().toLowerCase() : '';
  if (!query) return { content: 'Missing query', isError: true };
  const maxResults = normalizeMaxResults(input.maxResults, DEFAULT_MAX_RESULTS);

  const files = getReadableTextFiles(plugin)
    .map(file => file.path)
    .filter(path => path.toLowerCase().includes(query))
    .slice(0, maxResults);

  return { content: formatJson({ files, truncated: files.length >= maxResults }) };
}

async function grepVault(
  plugin: ClaudianPlugin,
  input: Record<string, unknown>,
): Promise<GeminiToolExecutionResult> {
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (!query) return { content: 'Missing query', isError: true };
  const lowerQuery = query.toLowerCase();
  const maxResults = normalizeMaxResults(input.maxResults, 50);
  const matches: Array<{ path: string; line: number; preview: string }> = [];

  for (const file of getReadableTextFiles(plugin)) {
    if (matches.length >= maxResults) break;
    const content = await plugin.app.vault.cachedRead(file);
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].toLowerCase().includes(lowerQuery)) {
        matches.push({
          path: file.path,
          line: i + 1,
          preview: lines[i].slice(0, 300),
        });
        if (matches.length >= maxResults) break;
      }
    }
  }

  return { content: formatJson({ matches, truncated: matches.length >= maxResults }) };
}

async function ensureParentFolder(plugin: ClaudianPlugin, path: string): Promise<void> {
  const parts = path.split('/');
  parts.pop();
  let current = '';

  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const existing = plugin.app.vault.getAbstractFileByPath(current);
    if (existing instanceof TFolder) {
      continue;
    }
    if (existing) {
      throw new Error(`Cannot create folder ${current}; a file exists at that path.`);
    }
    await plugin.app.vault.createFolder(current);
  }
}

async function writeVaultFile(
  plugin: ClaudianPlugin,
  input: Record<string, unknown>,
): Promise<GeminiToolExecutionResult> {
  const path = normalizeVaultPath(input.path);
  const content = requireString(input.content, 'content');
  const blocked = validateWritablePath(path);
  if (blocked) return { content: blocked, isError: true };

  const existing = plugin.app.vault.getAbstractFileByPath(path);
  if (existing && !(existing instanceof TFile)) {
    return { content: `Cannot write file; path is a folder: ${path}`, isError: true };
  }
  if (existing && input.overwrite !== true) {
    return { content: `File already exists: ${path}. Set overwrite=true to replace it.`, isError: true };
  }

  await ensureParentFolder(plugin, path);
  if (existing instanceof TFile) {
    await plugin.app.vault.modify(existing, content);
    return { content: formatJson({ path, action: 'overwritten', bytes: content.length }) };
  }

  await plugin.app.vault.create(path, content);
  return { content: formatJson({ path, action: 'created', bytes: content.length }) };
}

async function appendVaultFile(
  plugin: ClaudianPlugin,
  input: Record<string, unknown>,
): Promise<GeminiToolExecutionResult> {
  const path = normalizeVaultPath(input.path);
  const content = requireString(input.content, 'content');
  const createIfMissing = input.createIfMissing !== false;
  const blocked = validateWritablePath(path);
  if (blocked) return { content: blocked, isError: true };

  const existing = plugin.app.vault.getAbstractFileByPath(path);
  if (existing && !(existing instanceof TFile)) {
    return { content: `Cannot append file; path is a folder: ${path}`, isError: true };
  }

  if (!existing) {
    if (!createIfMissing) {
      return { content: `File not found: ${path}`, isError: true };
    }
    await ensureParentFolder(plugin, path);
    await plugin.app.vault.create(path, content);
    return { content: formatJson({ path, action: 'created', bytes: content.length }) };
  }

  await plugin.app.vault.append(existing, content);
  return { content: formatJson({ path, action: 'appended', bytes: content.length }) };
}

async function replaceInVaultFile(
  plugin: ClaudianPlugin,
  input: Record<string, unknown>,
): Promise<GeminiToolExecutionResult> {
  const path = normalizeVaultPath(input.path);
  const search = requireString(input.search, 'search');
  const replacement = requireString(input.replacement, 'replacement');
  const replaceAll = input.replaceAll === true;
  const blocked = validateWritablePath(path);
  if (blocked) return { content: blocked, isError: true };
  if (!search) return { content: 'Search text cannot be empty.', isError: true };

  const file = plugin.app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) {
    return { content: `File not found: ${path}`, isError: true };
  }

  const original = await plugin.app.vault.read(file);
  if (!original.includes(search)) {
    return { content: `Search text not found in ${path}`, isError: true };
  }

  const occurrences = original.split(search).length - 1;
  const updated = replaceAll
    ? original.split(search).join(replacement)
    : original.replace(search, replacement);
  await plugin.app.vault.modify(file, updated);
  return {
    content: formatJson({
      path,
      action: 'replaced',
      replacements: replaceAll ? occurrences : 1,
    }),
  };
}

async function createVaultFolder(
  plugin: ClaudianPlugin,
  input: Record<string, unknown>,
): Promise<GeminiToolExecutionResult> {
  const path = normalizeVaultPath(input.path);
  const blocked = validateWritablePath(path);
  if (blocked) return { content: blocked, isError: true };

  const existing = plugin.app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFolder) {
    return { content: formatJson({ path, action: 'already_exists' }) };
  }
  if (existing) {
    return { content: `Cannot create folder; a file exists at ${path}`, isError: true };
  }

  await ensureParentFolder(plugin, `${path}/placeholder`);
  if (!plugin.app.vault.getAbstractFileByPath(path)) {
    await plugin.app.vault.createFolder(path);
  }
  return { content: formatJson({ path, action: 'created' }) };
}
