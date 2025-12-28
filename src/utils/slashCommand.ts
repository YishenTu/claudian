/**
 * Claudian - Slash command parsing utilities
 *
 * Core parsing logic for slash command YAML frontmatter.
 * Extracted to utils/ to avoid cross-layer dependencies.
 */

/** Parsed slash command frontmatter and prompt content. */
export interface ParsedSlashCommandContent {
  description?: string;
  argumentHint?: string;
  allowedTools?: string[];
  model?: string;
  promptContent: string;
}

/**
 * Parses YAML frontmatter from command content.
 * Returns parsed metadata and the remaining prompt content.
 */
export function parseSlashCommandContent(content: string): ParsedSlashCommandContent {
  const frontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
  const match = content.match(frontmatterPattern);

  if (!match) {
    return { promptContent: content };
  }

  const yamlContent = match[1];
  const promptContent = match[2];
  const result: ParsedSlashCommandContent = { promptContent };

  const lines = yamlContent.split(/\r?\n/);
  let arrayKey: string | null = null;
  let arrayItems: string[] = [];

  const flushArray = () => {
    if (arrayKey === 'allowed-tools') {
      result.allowedTools = arrayItems;
    }
    arrayKey = null;
    arrayItems = [];
  };

  for (const line of lines) {
    const trimmedLine = line.trim();

    if (arrayKey) {
      if (trimmedLine.startsWith('- ')) {
        arrayItems.push(unquoteYamlString(trimmedLine.slice(2).trim()));
        continue;
      }

      if (trimmedLine === '') {
        continue;
      }

      flushArray();
    }

    const colonIndex = line.indexOf(':');
    if (colonIndex <= 0) {
      continue;
    }

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    switch (key) {
      case 'description':
        result.description = unquoteYamlString(value);
        break;
      case 'argument-hint':
        result.argumentHint = unquoteYamlString(value);
        break;
      case 'model':
        result.model = unquoteYamlString(value);
        break;
      case 'allowed-tools':
        if (!value) {
          arrayKey = key;
          arrayItems = [];
          break;
        }

        if (value.startsWith('[') && value.endsWith(']')) {
          result.allowedTools = value
            .slice(1, -1)
            .split(',')
            .map((s) => unquoteYamlString(s.trim()))
            .filter(Boolean);
          break;
        }

        result.allowedTools = [unquoteYamlString(value)].filter(Boolean);
        break;
    }
  }

  if (arrayKey) {
    flushArray();
  }

  return result;
}

function unquoteYamlString(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
