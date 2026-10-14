import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { t } from '@/i18n/i18n';

/** Transcript buttons carrying this attribute open the named session through the transcript's owner. */
const SESSION_LINK_ATTRIBUTE = 'data-claudian-open-session';

export interface SessionLinkTarget {
  title?: string;
  providerId?: string;
}

/** Each registered transcript resolves session ids to their current title and provider. */
const sessionResolvers = new WeakMap<HTMLElement, (sessionId: string) => SessionLinkTarget | null>();

function resolveSession(parent: HTMLElement, sessionId: string): SessionLinkTarget | null {
  for (let el: HTMLElement | null = parent; el; el = el.parentElement) {
    const resolve = sessionResolvers.get(el);
    if (resolve) return resolve(sessionId);
  }
  return null;
}

/** Display name for a registered provider; unknown ids (older or removed providers) show as stored. */
export function getSessionProviderName(providerId: string): string {
  try {
    return ProviderRegistry.getProviderDisplayName(providerId);
  } catch {
    return providerId;
  }
}

/**
 * A native button that opens a session when its transcript has an open handler. The visible
 * text is the accessible name; the tooltip names the provider (when known) and session id.
 */
export function createSessionLink(
  parent: HTMLElement,
  link: { sessionId: string; text?: string; provider?: string; cls?: string; tooltip?: boolean },
): HTMLButtonElement {
  // Without stored text (older results), name the session by its current title, then its id.
  const needsLookup = !link.text || (link.tooltip !== false && !link.provider);
  const known = needsLookup ? resolveSession(parent, link.sessionId) : null;
  const provider = link.provider ?? known?.providerId;
  const button = parent.createEl('button', {
    cls: ['claudian-session-link', ...(link.cls ? [link.cls] : [])],
    text: link.text ?? known?.title ?? link.sessionId,
    attr: {
      type: 'button',
      [SESSION_LINK_ATTRIBUTE]: link.sessionId,
    },
  });
  if (link.tooltip !== false) {
    button.setAttribute('title', provider
      ? t('chat.sessionTools.openProviderSession', { provider: getSessionProviderName(provider), sessionId: link.sessionId })
      : t('chat.sessionTools.openSession', { sessionId: link.sessionId }));
  }
  return button;
}

/** Delegates session-link activation for every live and replayed card under `container`. */
export function registerSessionLinkHandler(
  container: HTMLElement,
  open: (sessionId: string) => void,
  resolve?: (sessionId: string) => SessionLinkTarget | null,
): () => void {
  if (resolve) sessionResolvers.set(container, resolve);
  const handler = (event: MouseEvent) => {
    const target = event.target as Element | null;
    const link = target?.closest<HTMLElement>(`[${SESSION_LINK_ATTRIBUTE}]`);
    const sessionId = link && container.contains(link) ? link.getAttribute(SESSION_LINK_ATTRIBUTE) : null;
    if (!sessionId) return;
    event.preventDefault();
    open(sessionId);
  };
  container.addEventListener('click', handler);
  return () => {
    container.removeEventListener('click', handler);
    if (resolve && sessionResolvers.get(container) === resolve) sessionResolvers.delete(container);
  };
}
