import { stripCodexQuestionReplies } from './codexQuestionNormalization';
import { type CodeRange, getCodexUserCodeRanges } from './codexUserCode';

const CODEX_IMAGE_OPEN_TAG_PATTERN = /^<image\b[^>]*>$/i;
const CODEX_IMAGE_CLOSE_TAG_PATTERN = /^<\/image>$/i;
const CODEX_EMPTY_IMAGE_TAG_PATTERN = /^<image\b[^>]*>\s*<\/image>$/i;
const CODEX_EMPTY_IMAGE_TAG_PATTERN_GLOBAL = /<image\b[^>]*>\s*<\/image>\s*/gi;

const CODEX_CONTROL_BLOCK_TAGS = [
  'recommended_plugins',
  'system_instruction',
  'environment_context',
  'turn_aborted',
  'user-preferences',
  'subagent_notification',
  'skill',
];

const CODEX_AGENTS_INSTRUCTIONS_PREFIX = '# AGENTS.md instructions';
const CODEX_AGENTS_INSTRUCTIONS_CLOSE_TAG = '</INSTRUCTIONS>';

function stripLeadingTaggedBlock(text: string, tagName: string): string | null {
  const openTag = `<${tagName}>`;
  if (!text.startsWith(openTag)) {
    return null;
  }

  const closeTag = `</${tagName}>`;
  const closeIndex = text.indexOf(closeTag, openTag.length);
  if (closeIndex === -1) {
    return '';
  }

  return text.slice(closeIndex + closeTag.length);
}

function stripLeadingAgentsInstructions(text: string): string | null {
  if (!text.startsWith(CODEX_AGENTS_INSTRUCTIONS_PREFIX)) {
    return null;
  }

  const closeIndex = text.indexOf(CODEX_AGENTS_INSTRUCTIONS_CLOSE_TAG);
  if (closeIndex === -1) {
    return '';
  }

  return text.slice(closeIndex + CODEX_AGENTS_INSTRUCTIONS_CLOSE_TAG.length);
}

function stripLeadingCodexControlMetadata(text: string): string {
  let remaining = text;

  while (remaining) {
    const candidate = remaining.trimStart();
    const withoutAgentsInstructions = stripLeadingAgentsInstructions(candidate);
    if (withoutAgentsInstructions !== null) {
      remaining = withoutAgentsInstructions;
      continue;
    }

    let strippedTaggedBlock = false;
    for (const tagName of CODEX_CONTROL_BLOCK_TAGS) {
      const next = stripLeadingTaggedBlock(candidate, tagName);
      if (next === null) {
        continue;
      }

      remaining = next;
      strippedTaggedBlock = true;
      break;
    }

    if (!strippedTaggedBlock) {
      break;
    }
  }

  return remaining;
}

function getCodeRanges(text: string): CodeRange[] {
  return /<image\b|<\/image>/i.test(text) ? getCodexUserCodeRanges(text) : [];
}

/** Preserve indentation that makes native user-input wrappers literal code. */
export function trimCodexUserText(text: string): string {
  const firstContent = text.search(/\S/);
  const controlPattern = /<image\b|<\/image>|<send_user_message_question_reply>/i;
  const leadingCode = (controlPattern.test(text) ? getCodexUserCodeRanges(text) : [])
    .find(range => range.lineStart !== undefined
      && range.from === firstContent && controlPattern.test(text.slice(range.from, range.to)));
  return leadingCode ? text.slice(leadingCode.lineStart).trimEnd() : text.trim();
}

function stripImagePlaceholders(text: string, ranges: readonly CodeRange[], offset: number): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  const isCode = (index: number) => ranges.some(range => index >= range.from && index < range.to);
  // Lezer starts indented code at its content; retain the preceding code boundary.
  const keepCodeWhitespace = (match: string, index: number) => {
    const whitespaceStart = match.trimEnd().length;
    return ranges.some(range => range.from >= offset + index + whitespaceStart
      && range.from <= offset + index + match.length)
      ? match.slice(whitespaceStart) : '';
  };

  if (!isCode(offset + text.indexOf(trimmed)) && (
    CODEX_IMAGE_OPEN_TAG_PATTERN.test(trimmed)
    || CODEX_IMAGE_CLOSE_TAG_PATTERN.test(trimmed)
    || CODEX_EMPTY_IMAGE_TAG_PATTERN.test(trimmed)
  )) {
    return keepCodeWhitespace(text, 0);
  }

  return text.replace(CODEX_EMPTY_IMAGE_TAG_PATTERN_GLOBAL, (match: string, index: number) => {
    if (isCode(offset + index)) return match;
    return keepCodeWhitespace(match, index);
  });
}

export function stripCodexImagePlaceholderText(text: string): string {
  return stripImagePlaceholders(text, getCodeRanges(text), 0);
}

export function joinCodexUserTextParts(parts: readonly string[], separator = ''): string {
  // Code can span native text parts; keep their original offsets during cleanup.
  const ranges = getCodeRanges(parts.join(separator));
  let offset = 0;
  return parts.map(text => {
    const visible = stripImagePlaceholders(text, ranges, offset);
    offset += text.length + separator.length;
    return visible;
  }).filter(text => text.length > 0).join(separator);
}

export function extractCodexUserVisibleText(text: string): string | null {
  text = stripCodexQuestionReplies(text);
  const withoutImagePlaceholders = stripCodexImagePlaceholderText(text);
  const visible = trimCodexUserText(stripCodexImagePlaceholderText(
    stripLeadingCodexControlMetadata(withoutImagePlaceholders),
  ));

  return visible ? visible : null;
}
