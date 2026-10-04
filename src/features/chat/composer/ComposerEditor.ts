import { defaultKeymap, history, historyKeymap, insertNewline } from '@codemirror/commands';
import { Annotation, Compartment, EditorSelection, EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, keymap, placeholder, WidgetType } from '@codemirror/view';
import { type App, type Component, MarkdownRenderer, setIcon } from 'obsidian';

import type { ProviderCommandKind } from '@/core/providers/commands/ProviderCommandEntry';
import { t } from '@/i18n/i18n';
import type { ComposerCommandResolver, ComposerInputElement } from '@/shared/composer-dropdown/types';
import { registerFileLinkHandler } from '@/utils/fileLink';

import { type ComposerSessionMention, findComposerSessionMentions } from './composerSessionMentions';
import { filterComposerTextTokens, findComposerWikilinks } from './composerWikilinks';

const refreshLinks = StateEffect.define<null>();
const programmatic = Annotation.define<boolean>();

class WikilinkWidget extends WidgetType {
  constructor(
    private readonly markdown: string,
    private readonly app: App,
    private readonly component: Component,
    private readonly revision: number,
  ) {
    super();
  }

  eq(other: WikilinkWidget): boolean {
    return this.markdown === other.markdown && this.revision === other.revision;
  }

  toDOM(view: EditorView): HTMLElement {
    const ownerWindow = view.dom.ownerDocument.win as Window & { createSpan: typeof createSpan };
    const el = ownerWindow.createSpan();
    el.className = 'claudian-composer-wikilink markdown-rendered';
    el.contentEditable = 'false';
    void MarkdownRenderer.render(this.app, this.markdown, el, '', this.component).then(() => {
      if (el.isConnected) view.requestMeasure();
    }).catch(() => { el.textContent = this.markdown; });
    return el;
  }
}

function createChip(view: EditorView, cls: string, label: string, icon: string | null, text: string): HTMLElement {
  const ownerWindow = view.dom.ownerDocument.win as Window & { createSpan: typeof createSpan };
  const el = ownerWindow.createSpan();
  el.className = `claudian-composer-chip ${cls}`;
  el.contentEditable = 'false';
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', label);
  if (icon) setIcon(el.createSpan({ cls: 'claudian-composer-chip-icon' }), icon);
  el.append(view.dom.ownerDocument.createTextNode(text));
  return el;
}

class SessionMentionWidget extends WidgetType {
  constructor(private readonly title: string) { super(); }

  eq(other: SessionMentionWidget): boolean {
    return this.title === other.title;
  }

  toDOM(view: EditorView): HTMLElement {
    return createChip(view, 'claudian-composer-session', `Session: ${this.title}`, 'message-circle-more', this.title);
  }
}

class CommandWidget extends WidgetType {
  constructor(private readonly token: string, private readonly kind: ProviderCommandKind) { super(); }

  eq(other: CommandWidget): boolean {
    return this.token === other.token && this.kind === other.kind;
  }

  toDOM(view: EditorView): HTMLElement {
    if (this.kind === 'skill') {
      const name = this.token.slice(1);
      return createChip(view, 'claudian-composer-skill', `Skill: ${name}`, 'zap', name);
    }
    const el = createChip(view, 'claudian-composer-command', `Command: ${this.token}`, null, this.token.slice(1));
    el.prepend(el.createSpan({ cls: 'claudian-composer-command-prefix', text: this.token[0] }));
    return el;
  }
}

interface ComposerCommandToken {
  index: number;
  fullMatch: string;
  kind: ProviderCommandKind;
}

type ComposerToken = ComposerSessionMention | ReturnType<typeof findComposerWikilinks>[number] | ComposerCommandToken;

/**
 * A token becomes a chip once whitespace completes it, so the one being typed stays editable text.
 * An existing chip stays one when that whitespace is removed, until the token itself changes.
 */
function findComposerCommands(
  text: string, resolve: ComposerCommandResolver | null, wasChip: (from: number, to: number) => boolean,
): ComposerCommandToken[] {
  if (!resolve) return [];
  const tokens = [...text.matchAll(/(?<=^|\s)[^\s\w]\S*(?=\s|$)/g)].flatMap(match => {
    const end = match.index + match[0].length;
    if (end === text.length && !wasChip(match.index, end)) return [];
    const kind = resolve(match[0], match.index === 0);
    return kind ? [{ index: match.index, fullMatch: match[0], kind }] : [];
  });
  return tokens.length ? filterComposerTextTokens(text, tokens) : [];
}

/** Owns the editable Markdown document; wikilink presentation is derived from its text. */
export class ComposerEditor {
  readonly element: ComposerInputElement;
  private state: EditorState;
  private view: EditorView | null = null;
  private readonly historyConfig = new Compartment();
  private readonly placeholderConfig = new Compartment();
  private placeholderText = 'Ask to make changes, @mention files, run /commands';
  private ghostText: string | null = null;
  private destroyed = false;
  private ariaObserver: MutationObserver | null = null;
  private inputPending = false;
  private linkRevision = 0;
  private commandResolver: ComposerCommandResolver | null = null;
  private readonly removeFileLinkHandler: () => void;

  constructor(parent: HTMLElement, private readonly app: App, private readonly component: Component) {
    const host = parent.createDiv({
      cls: 'claudian-input claudian-composer-editor',
      attr: { role: 'textbox', 'aria-label': 'Message', 'aria-multiline': 'true', tabindex: '0', dir: 'auto' },
    });
    this.element = host as unknown as ComposerInputElement;
    this.removeFileLinkHandler = registerFileLinkHandler(app, host);
    const decorations = StateField.define<DecorationSet>({
      create: state => this.decorate(state, Decoration.none),
      update: (value, transaction) => this.decorate(transaction.state, value.map(transaction.changes)),
      provide: field => EditorView.decorations.from(field),
    });
    this.state = EditorState.create({
      extensions: [
        decorations, this.historyConfig.of(history()),
        keymap.of([
          { key: 'Enter', run: insertNewline, shift: insertNewline },
          { key: 'Backspace', run: view => {
            const { main, ranges } = view.state.selection;
            if (!main.empty || ranges.length !== 1) return false;
            let chipStart: number | null = null;
            view.state.field(decorations).between(main.head, main.head, (from, to) => {
              if (to === main.head) chipStart = from;
            });
            if (chipStart === null) return false;
            view.dispatch({
              changes: { from: chipStart, to: main.head },
              selection: { anchor: chipStart },
              userEvent: 'delete.backward',
            });
            return true;
          } },
          ...historyKeymap, ...defaultKeymap,
        ]),
        EditorView.lineWrapping,
        this.placeholderConfig.of(placeholder(this.placeholderText)),
        // CodeMirror turns off native spellcheck and autocorrect, which also disables macOS text replacements.
        EditorView.contentAttributes.of({
          'aria-label': 'Message', 'aria-multiline': 'true', role: 'textbox', spellcheck: 'true', autocorrect: 'on',
        }),
        EditorView.contentAttributes.of(view => {
          const description = this.ghostDescription(view.state.doc.length);
          return description ? { 'aria-description': description } : null;
        }),
        EditorView.domEventHandlers({ input: event => { event.stopPropagation(); return false; } }),
        EditorView.updateListener.of(update => {
          this.state = update.state;
          if (update.docChanged && !update.transactions.every(transaction => transaction.annotation(programmatic))) {
            this.scheduleInput();
          }
        }),
      ],
    });
    Object.defineProperties(host, {
      value: {
        get: () => this.state.doc.toString(),
        set: (value: string) => {
          // A replacement starts a new draft with its own undo history.
          this.apply(this.state.update({
            changes: { from: 0, to: this.state.doc.length, insert: value },
            selection: { anchor: value.length },
            effects: this.historyConfig.reconfigure([]),
            annotations: [programmatic.of(true), Transaction.addToHistory.of(false)],
          }));
          this.apply(this.state.update({ effects: this.historyConfig.reconfigure(history()) }));
        },
      },
      selectionStart: {
        get: () => this.state.selection.main.from,
        set: (value: number) => this.setSelection(value, Math.max(value, this.state.selection.main.to)),
      },
      selectionEnd: {
        get: () => this.state.selection.main.to,
        set: (value: number) => this.setSelection(Math.min(value, this.state.selection.main.from), value),
      },
      placeholder: {
        get: () => this.placeholderText,
        set: (value: string) => {
          this.placeholderText = value;
          this.refreshPlaceholder();
        },
      },
    });
    this.element.setGhostText = text => {
      if (this.ghostText === text) return;
      this.ghostText = text;
      this.refreshPlaceholder();
    };
    this.element.replaceText = (from, to, text) => {
      const change = this.state.changes({ from, to, insert: text });
      this.apply(this.state.update({
        changes: change,
        selection: { anchor: from + text.length },
        annotations: programmatic.of(true),
        userEvent: 'input.complete',
      }));
    };
    this.element.setCommandResolver = resolver => {
      this.commandResolver = resolver;
      this.refreshLinks();
    };
    host.setAttribute('data-placeholder', this.placeholderText);
    host.addEventListener('focusin', this.onFocusIn);
  }

  refreshLinks(): void {
    if (this.destroyed) return;
    this.linkRevision++;
    this.apply(this.state.update({ effects: refreshLinks.of(null) }));
  }

  private refreshPlaceholder(): void {
    const text = this.ghostText ?? this.placeholderText;
    this.element.setAttribute('data-placeholder', text);
    this.apply(this.state.update({
      effects: this.placeholderConfig.reconfigure(placeholder(this.ghostText ? this.createGhostContent(this.ghostText) : text)),
    }));
  }

  private ghostDescription(docLength: number): string | null {
    return this.ghostText && docLength === 0 ? `${this.ghostText}. ${t('chat.promptSuggestionHint')}` : null;
  }

  /** Until the editor mounts on first focus, the host is the textbox and carries the description itself. */
  private syncHostDescription(): void {
    const description = this.view ? null : this.ghostDescription(this.state.doc.length);
    if (description) this.element.setAttribute('aria-description', description);
    else this.element.removeAttribute('aria-description');
  }

  /** CodeMirror hides the placeholder from assistive tech; the content `aria-description` announces it. */
  private createGhostContent(text: string): HTMLElement {
    const content = createSpan();
    content.createSpan({ text });
    content.append(' ');
    content.createSpan({ cls: 'claudian-prompt-suggestion-hint', text: `(${t('chat.promptSuggestionHint')})` });
    return content;
  }

  destroy(): void {
    this.destroyed = true;
    this.element.removeEventListener('focusin', this.onFocusIn);
    this.ariaObserver?.disconnect();
    this.removeFileLinkHandler();
    this.view?.destroy();
    this.view = null;
  }

  // Chromium skips the `focus` event's `focusin` when the handler moves focus,
  // which would hide this handoff from ancestors that track focus transitions.
  private readonly onFocusIn = (event: FocusEvent): void => {
    if (this.destroyed) return;
    if (event.target !== this.element) return;
    if (!this.view) {
      this.element.replaceChildren();
      this.element.removeAttribute('role');
      this.element.removeAttribute('aria-multiline');
      this.element.setAttribute('tabindex', '-1');
      this.view = new EditorView({ state: this.state, parent: this.element });
      this.syncHostDescription();
      const attributes = ['aria-autocomplete', 'aria-expanded', 'aria-activedescendant', 'aria-controls', 'aria-haspopup'];
      const syncAria = () => {
        for (const attribute of attributes) {
          const value = this.element.getAttribute(attribute);
          if (value === null) this.view?.contentDOM.removeAttribute(attribute);
          else this.view?.contentDOM.setAttribute(attribute, value);
        }
      };
      syncAria();
      this.ariaObserver = new this.element.ownerDocument.defaultView!.MutationObserver(syncAria);
      this.ariaObserver.observe(this.element, { attributes: true, attributeFilter: attributes });
    }
    this.view.focus();
  };

  private findTokens(text: string, previous: DecorationSet): ComposerToken[] {
    const tokens: ComposerToken[] = [];
    const wasChip = (from: number, to: number) => {
      let found = false;
      previous.between(from, to, (start, end) => { found ||= start === from && end === to; });
      return found;
    };
    for (const token of [
      ...findComposerSessionMentions(text),
      ...findComposerWikilinks(text),
      ...findComposerCommands(text, this.commandResolver, wasChip),
    ]) {
      const end = token.index + token.fullMatch.length;
      if (!tokens.some(other => token.index < other.index + other.fullMatch.length && end > other.index)) {
        tokens.push(token);
      }
    }
    return tokens;
  }

  private decorate(state: EditorState, previous: DecorationSet): DecorationSet {
    const links = this.findTokens(state.doc.toString(), previous).filter(link => {
      const end = link.index + link.fullMatch.length;
      return !state.selection.ranges.some(range =>
        (range.from > link.index && range.from < end) || (range.to > link.index && range.to < end));
    });
    return Decoration.set(links.map(link => Decoration.replace({
      widget: 'conversationId' in link
        ? new SessionMentionWidget(link.title)
        : 'kind' in link
          ? new CommandWidget(link.fullMatch, link.kind)
          : new WikilinkWidget(link.fullMatch, this.app, this.component, this.linkRevision),
    }).range(link.index, link.index + link.fullMatch.length)), true);
  }

  private setSelection(from: number, to: number): void {
    const clamp = (position: number) => Math.max(0, Math.min(position, this.state.doc.length));
    this.apply(this.state.update({ selection: EditorSelection.single(clamp(from), clamp(to)) }));
  }

  private apply(transaction: Transaction): void {
    if (this.destroyed) return;
    if (this.view) this.view.dispatch(transaction);
    else {
      this.state = transaction.state;
      this.element.textContent = this.state.doc.toString();
      this.syncHostDescription();
    }
  }

  private scheduleInput(): void {
    if (this.inputPending) return;
    this.inputPending = true;
    // Mode and completion listeners may dispatch editor changes of their own.
    queueMicrotask(() => {
      this.inputPending = false;
      if (!this.destroyed) this.emitInput();
    });
  }

  private emitInput(): void {
    const EventConstructor = this.element.ownerDocument.defaultView!.Event;
    this.element.dispatchEvent(new EventConstructor('input', { bubbles: true }));
  }
}
