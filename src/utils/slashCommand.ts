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
      // Use lookbehind + lookahead to only replace isolated newlines (not preceded or followed by \n)
      value = blockScalarLines.join('\n').replace(/(?<!\n)\n(?!\n)/g, ' ').trim();
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

      // Compute leading spaces once
      const leadingSpaces = line.match(/^(\s*)/)?.[1].length ?? 0;

      // Detect indentation of first content line
      if (blockScalarIndent === null) {
        // Block scalar content MUST be indented (at least 1 space)
        if (leadingSpaces === 0) {
          // This line is not block scalar content - flush empty block scalar and process normally
          flushBlockScalar();
          // Fall through to process this line as a key-value pair
        } else {
          blockScalarIndent = leadingSpaces;
          // Remove the base indentation and add content
          const content = line.slice(blockScalarIndent);
          blockScalarLines.push(content);
          continue;
        }
      } else if (leadingSpaces >= blockScalarIndent) {
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

    // Check for block scalar indicators (| or >) with optional modifiers (-, +)
    // Only enable for supported keys to avoid silently discarding content
    const blockScalarMatch = value.match(/^([|>])([+-])?$/);
    if (blockScalarMatch && (key === 'description' || key === 'argument-hint' || key === 'model')) {
      blockScalarKey = key;
      blockScalarStyle = blockScalarMatch[1] === '|' ? 'literal' : 'folded';
      // Note: chomping indicator (blockScalarMatch[2]) is currently ignored
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
