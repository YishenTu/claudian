/**
 * Claudian - Slash command utilities
 *
 * Core parsing logic for slash command YAML frontmatter and warning formatting.
 */

/** Formats expansion errors for display. */
export function formatSlashCommandWarnings(errors: string[]): string {
  const maxItems = 3;
  const head = errors.slice(0, maxItems);
  const more = errors.length > maxItems ? `\n...and ${errors.length - maxItems} more` : '';
  return `Slash command expansion warnings:\n- ${head.join('\n- ')}${more}`;
}

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
  let blockScalarKey: string | null = null;
  let blockScalarStyle: 'literal' | 'folded' | null = null;
  let blockScalarLines: string[] = [];
  let blockScalarIndent: number | null = null;

  const flushArray = () => {
    if (arrayKey === 'allowed-tools') {
      result.allowedTools = arrayItems;
    }
    arrayKey = null;
    arrayItems = [];
  };

  const flushBlockScalar = () => {
    if (!blockScalarKey) return;

    let value: string;
    if (blockScalarStyle === 'literal') {
      // Literal (|): preserve line breaks
      value = blockScalarLines.join('\n');
    } else {
      // Folded (>): join lines with spaces, but preserve double line breaks as paragraphs
      value = blockScalarLines.join('\n').replace(/\n(?!\n)/g, ' ').trim();
    }

    switch (blockScalarKey) {
      case 'description':
        result.description = value;
        break;
      case 'argument-hint':
        result.argumentHint = value;
        break;
      case 'model':
        result.model = value;
        break;
    }

    blockScalarKey = null;
    blockScalarStyle = null;
    blockScalarLines = [];
    blockScalarIndent = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();

    // Handle block scalar content
    if (blockScalarKey) {
      // Empty line: preserve it
      if (trimmedLine === '') {
        blockScalarLines.push('');
        continue;
      }

      // Detect indentation of first content line
      if (blockScalarIndent === null) {
        const leadingSpaces = line.match(/^(\s*)/)?.[1].length ?? 0;
        blockScalarIndent = leadingSpaces;
      }

      // Check if this line is part of the block scalar (must be indented more than the key)
      const leadingSpaces = line.match(/^(\s*)/)?.[1].length ?? 0;
      if (leadingSpaces >= blockScalarIndent) {
        // Remove the base indentation
        const content = line.slice(blockScalarIndent);
        blockScalarLines.push(content);
        continue;
      } else {
        // This line is not indented enough, so the block scalar has ended
        flushBlockScalar();
        // Fall through to process this line normally
      }
    }

    // Handle array items
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

    // Check for block scalar indicators (| or >)
    if (value === '|' || value === '>') {
      blockScalarKey = key;
      blockScalarStyle = value === '|' ? 'literal' : 'folded';
      blockScalarLines = [];
      blockScalarIndent = null;
      continue;
    }

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

  // Flush any remaining block scalar or array
  if (blockScalarKey) {
    flushBlockScalar();
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
