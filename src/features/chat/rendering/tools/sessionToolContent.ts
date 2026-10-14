import type { ToolCallInfo } from '@/core/types';
import { createSessionLink } from '@/features/chat/rendering/sessionLinks';
import { getInputText, renderLinesExpanded } from '@/features/chat/rendering/tools/toolContentPrimitives';
import { t } from '@/i18n/i18n';

/**
 * Session tool cards read the neutral JSON result stored on the tool call, so live cards and
 * history replay render alike. Every field is optional here: older results predate some fields,
 * and anything unparseable (including error results) falls back to the raw result text.
 */

type ToolSnapshot = Pick<ToolCallInfo, 'input' | 'result'> & Partial<Pick<ToolCallInfo, 'status'>>;

interface SessionRow {
  sessionId: string;
  title: string;
  self: boolean;
}

interface Destinations {
  sessions: SessionRow[];
  truncated: boolean;
  hasProviders: boolean;
}

interface SendResult {
  sessionId: string;
  title?: string;
  provider?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function parseResult(tool: ToolSnapshot): Record<string, unknown> | null {
  if (tool.status === 'error' || tool.status === 'blocked' || !tool.result) return null;
  try {
    return asRecord(JSON.parse(tool.result));
  } catch {
    return null;
  }
}

function parseSessionRow(value: unknown): SessionRow | null {
  const row = asRecord(value);
  const sessionId = optionalString(row?.sessionId);
  if (!row || !sessionId) return null;
  return {
    sessionId,
    title: optionalString(row.title) ?? sessionId,
    self: row.self === true,
  };
}

function parseDestinations(tool: ToolSnapshot): Destinations | null {
  const result = parseResult(tool);
  if (!result || !Array.isArray(result.sessions)) return null;
  return {
    sessions: result.sessions.map(parseSessionRow).filter((row): row is SessionRow => row !== null),
    truncated: result.truncated === true,
    hasProviders: Array.isArray(result.providers) && result.providers.length > 0,
  };
}

function parseSendResult(tool: ToolSnapshot): SendResult | null {
  const result = parseResult(tool);
  const sessionId = optionalString(result?.sessionId);
  if (!result || !sessionId) return null;
  return {
    sessionId,
    title: optionalString(result.title),
    provider: optionalString(result.provider),
  };
}

function renderRawResult(container: HTMLElement, tool: ToolSnapshot): void {
  renderLinesExpanded(container, tool.result ?? '', 20);
}

function addBadge(parent: HTMLElement, text: string, modifier: string): void {
  parent.createSpan({ cls: `claudian-session-tool-badge claudian-session-tool-badge--${modifier}`, text });
}

// ============================================
// claudian_list_destinations
// ============================================

export function renderListDestinationsContent(container: HTMLElement, tool: ToolSnapshot): void {
  const destinations = parseDestinations(tool);
  if (!destinations) {
    renderRawResult(container, tool);
    return;
  }
  const root = container.createDiv({ cls: 'claudian-session-tool' });
  if (destinations.sessions.length === 0) {
    root.createDiv({ cls: 'claudian-tool-empty', text: t('chat.sessionTools.noSessions') });
  } else {
    const list = root.createEl('ul', { cls: 'claudian-session-tool-list' });
    for (const session of destinations.sessions) {
      const row = list.createEl('li', { cls: 'claudian-session-tool-row' });
      // The caller's own row names the transcript being read; it needs no link to itself.
      if (session.self) {
        row.createSpan({ cls: 'claudian-session-tool-title', text: session.title });
      } else {
        createSessionLink(row, { sessionId: session.sessionId, text: session.title, cls: 'claudian-session-tool-title', tooltip: false });
      }
      if (session.self) addBadge(row, t('chat.sessionTools.thisSession'), 'self');
    }
  }
  if (destinations.truncated) {
    root.createDiv({ cls: 'claudian-session-tool-note', text: t('chat.sessionTools.truncated') });
  }
  // The catalog is for the agent; the user already knows their enabled models.
  if (destinations.hasProviders) {
    root.createDiv({ cls: 'claudian-session-tool-note', text: t('chat.sessionTools.providersIncluded') });
  }
}

// ============================================
// claudian_send_message
// ============================================

export function renderSendMessageContent(container: HTMLElement, tool: ToolSnapshot): void {
  const result = parseSendResult(tool);
  const root = container.createDiv({ cls: 'claudian-session-tool' });
  if (!result) {
    renderRawResult(root, tool);
  } else {
    const fields = root.createEl('dl', { cls: 'claudian-session-tool-fields' });
    const addField = (label: string): HTMLElement => {
      fields.createEl('dt', { text: label });
      return fields.createEl('dd');
    };
    // A send that created its recipient names it as a new session; its first title is a placeholder.
    const createdSession = !getInputText(tool.input, 'sessionId');
    createSessionLink(addField(t('chat.sessionTools.recipient')), {
      sessionId: result.sessionId,
      text: createdSession ? t('chat.sessionTools.newSession') : result.title,
      provider: result.provider,
      cls: 'claudian-session-tool-title',
    });
    // A plain send needs no delivery line; steering and interrupting are worth calling out.
    const mode = getInputText(tool.input, 'mode');
    if (mode === 'steer') addField(t('chat.sessionTools.mode')).setText(t('chat.sessionTools.modeSteer'));
    if (mode === 'interrupt') addField(t('chat.sessionTools.mode')).setText(t('chat.sessionTools.modeInterrupt'));
    const model = getInputText(tool.input, 'model');
    if (model) addField(t('chat.sessionTools.model')).setText(model);
    const reasoning = getInputText(tool.input, 'reasoning');
    if (reasoning) addField(t('chat.sessionTools.reasoning')).setText(reasoning);
  }
  const text = getInputText(tool.input, 'text');
  if (text) {
    root.createDiv({ cls: 'claudian-session-tool-heading', text: t('chat.sessionTools.message') });
    root.createDiv({ cls: 'claudian-session-tool-message', text });
  }
}

// ============================================
// claudian_read_session
// ============================================

function parseTurn(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function renderReadSessionContent(container: HTMLElement, tool: ToolSnapshot): void {
  const result = parseResult(tool);
  const root = container.createDiv({ cls: 'claudian-session-tool' });
  const sessionId = optionalString(result?.sessionId) ?? getInputText(tool.input, 'sessionId');
  if (tool.result && !result) {
    renderRawResult(root, tool);
    return;
  }
  if (!sessionId) return;
  const fields = root.createEl('dl', { cls: 'claudian-session-tool-fields' });
  const addField = (label: string): HTMLElement => {
    fields.createEl('dt', { text: label });
    return fields.createEl('dd');
  };
  // Without a result yet, the link resolves the session's current title.
  createSessionLink(addField(t('chat.sessionTools.session')), {
    sessionId,
    text: optionalString(result?.title),
    provider: optionalString(result?.provider),
    cls: 'claudian-session-tool-title',
  });
  const from = parseTurn(result?.fromTurn);
  const to = parseTurn(result?.toTurn);
  const total = parseTurn(result?.totalTurns);
  if (from === undefined || to === undefined || total === undefined) return;
  // The transcript itself is for the agent; the user can open the session to read it.
  addField(t('chat.sessionTools.turns')).setText(to === 0
    ? t('chat.sessionTools.noTurns')
    : t('chat.sessionTools.turnRange', { from, to, total }));
}
