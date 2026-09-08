import { defaultKeymap, history, historyKeymap, insertNewline } from '@codemirror/commands';
import { Annotation, Compartment, EditorSelection, EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, keymap, placeholder, WidgetType } from '@codemirror/view';
import { type App, type Component, MarkdownRenderer } from 'obsidian';

import type { ComposerInputElement } from '@/shared/composer-dropdown/types';
import { registerFileLinkHandler } from '@/utils/fileLink';

import { findComposerWikilinks } from './composerWikilinks';

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

/** Owns the editable Markdown document; wikilink presentation is derived from its text. */
export class ComposerEditor {
  readonly element: ComposerInputElement;
  private state: EditorState;
  private view: EditorView | null = null;
  private readonly historyConfig = new Compartment();
  private readonly placeholderConfig = new Compartment();
  private placeholderText = 'Ask to make changes, @mention files, run /commands';
  private destroyed = false;
  private ariaObserver: MutationObserver | null = null;
  private inputPending = false;
  private linkRevision = 0;
  private readonly removeFileLinkHandler: () => void;

  constructor(parent: HTMLElement, private readonly app: App, private readonly component: Component) {
    const host = parent.createDiv({
      cls: 'claudian-input claudian-composer-editor',
      attr: { role: 'textbox', 'aria-label': 'Message', 'aria-multiline': 'true', tabindex: '0', dir: 'auto' },
    });
    this.element = host as unknown as ComposerInputElement;
    this.removeFileLinkHandler = registerFileLinkHandler(app, host);
    const decorations = StateField.define<DecorationSet>({
      create: state => this.decorate(state),
      update: (_value, transaction) => this.decorate(transaction.state),
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
            const link = findComposerWikilinks(view.state.doc.toString())
              .find(link => link.index + link.fullMatch.length === main.head);
            if (!link) return false;
            view.dispatch({
              changes: { from: link.index, to: main.head },
              selection: { anchor: link.index },
              userEvent: 'delete.backward',
            });
            return true;
          } },
          ...historyKeymap, ...defaultKeymap,
        ]),
        EditorView.lineWrapping,
        this.placeholderConfig.of(placeholder(this.placeholderText)),
        EditorView.contentAttributes.of({ 'aria-label': 'Message', 'aria-multiline': 'true', role: 'textbox' }),
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
          this.element.setAttribute('data-placeholder', value);
          this.apply(this.state.update({ effects: this.placeholderConfig.reconfigure(placeholder(value)) }));
        },
      },
    });
    this.element.replaceText = (from, to, text) => {
      const change = this.state.changes({ from, to, insert: text });
      this.apply(this.state.update({
        changes: change,
        selection: { anchor: from + text.length },
        annotations: programmatic.of(true),
        userEvent: 'input.complete',
      }));
    };
    host.setAttribute('data-placeholder', this.placeholderText);
    host.addEventListener('focus', this.onFocus);
  }

  refreshLinks(): void {
    if (this.destroyed) return;
    this.linkRevision++;
    this.apply(this.state.update({ effects: refreshLinks.of(null) }));
  }

  destroy(): void {
    this.destroyed = true;
    this.element.removeEventListener('focus', this.onFocus);
    this.ariaObserver?.disconnect();
    this.removeFileLinkHandler();
    this.view?.destroy();
    this.view = null;
  }

  private readonly onFocus = (): void => {
    if (this.destroyed) return;
    if (!this.view) {
      this.element.replaceChildren();
      this.element.removeAttribute('role');
      this.element.setAttribute('tabindex', '-1');
      this.view = new EditorView({ state: this.state, parent: this.element });
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

  private decorate(state: EditorState): DecorationSet {
    const links = findComposerWikilinks(state.doc.toString()).filter(link => {
      const end = link.index + link.fullMatch.length;
      return !state.selection.ranges.some(range =>
        (range.from > link.index && range.from < end) || (range.to > link.index && range.to < end));
    });
    return Decoration.set(links.map(link => Decoration.replace({
      widget: new WikilinkWidget(link.fullMatch, this.app, this.component, this.linkRevision),
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
