import { defaultKeymap, history, historyKeymap, insertNewline, invertedEffects } from '@codemirror/commands';
import { Annotation, Compartment, EditorSelection, EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, keymap, placeholder, WidgetType } from '@codemirror/view';

import type { ComposerFileMention, ComposerInputElement } from '@/shared/composer-dropdown/types';

const setMentions = StateEffect.define<readonly ComposerFileMention[]>();
const refreshMentions = StateEffect.define<null>();
const programmatic = Annotation.define<boolean>();

const mentionsField = StateField.define<readonly ComposerFileMention[]>({
  create: () => [],
  update(mentions, transaction) {
    let next = mentions.map(mention => ({
      ...mention,
      from: transaction.changes.mapPos(mention.from, 1),
      to: transaction.changes.mapPos(mention.to, -1),
    })).filter((mention, index) => mention.from < mention.to
      && transaction.newDoc.sliceString(mention.from, mention.to)
        === transaction.startState.doc.sliceString(mentions[index].from, mentions[index].to));
    for (const effect of transaction.effects) {
      if (effect.is(setMentions)) next = effect.value.map(mention => ({ ...mention }));
    }
    return next.filter(mention => mention.from >= 0 && mention.to <= transaction.newDoc.length
      && mention.from < mention.to && transaction.newDoc.sliceString(mention.from, mention.from + 1) === '@');
  },
});

class MentionWidget extends WidgetType {
  constructor(
    private readonly mention: ComposerFileMention,
    private readonly missing: boolean,
    private readonly remove: (mention: ComposerFileMention) => void,
    private readonly openFile?: (path: string) => void,
  ) { super(); }

  eq(other: MentionWidget): boolean {
    return this.mention.from === other.mention.from && this.mention.to === other.mention.to
      && this.mention.path === other.mention.path && this.missing === other.missing;
  }

  toDOM(view: EditorView): HTMLElement {
    const ownerWindow = view.dom.ownerDocument.win as Window & { createSpan: typeof createSpan };
    const chip = ownerWindow.createSpan();
    chip.className = `claudian-mention-chip${this.missing ? ' is-missing' : ''}`;
    chip.contentEditable = 'false';
    chip.title = this.mention.path;
    const label = this.openFile ? chip.createEl('button') : chip.createSpan();
    if (this.openFile) {
      label.setAttribute('type', 'button');
      label.className = 'claudian-mention-open';
      label.setAttribute('aria-label', `Open ${this.mention.path}${this.missing ? ' (Missing)' : ''}`);
      label.addEventListener('click', event => {
        event.preventDefault();
        this.openFile?.(this.mention.path);
      });
    }
    const isFolder = this.mention.path.endsWith('/');
    const basename = this.mention.path.replace(/\/$/, '').split(/[\\/]/).pop() ?? this.mention.path;
    const name = isFolder ? `${basename}/` : basename.replace(/\.md$/i, '');
    label.textContent = `${name}${this.missing ? ' · Missing' : ''}`;
    const button = chip.createEl('button');
    button.type = 'button';
    button.className = 'claudian-mention-remove';
    button.setAttribute('aria-label', `Remove ${this.mention.path}`);
    button.textContent = '×';
    button.addEventListener('click', event => {
      event.preventDefault();
      this.remove(this.mention);
    });
    return chip;
  }
}

export interface ComposerEditorOptions {
  readonly isFileAvailable?: (path: string) => boolean;
  readonly onOpenFile?: (path: string) => void;
}

/** Owns the editable document and selected file/folder tokens; serialization stays plain text. */
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
  private readonly isFileAvailable: (path: string) => boolean;
  private readonly onOpenFile?: (path: string) => void;

  constructor(parent: HTMLElement, options: ComposerEditorOptions = {}) {
    this.isFileAvailable = options.isFileAvailable ?? (() => true);
    this.onOpenFile = options.onOpenFile;
    const host = parent.createDiv({
      cls: 'claudian-input claudian-composer-editor',
      attr: { role: 'textbox', 'aria-label': 'Message', 'aria-multiline': 'true', tabindex: '0', dir: 'auto' },
    });
    this.element = host as unknown as ComposerInputElement;
    const decorations = StateField.define<DecorationSet>({
      create: state => this.decorate(state),
      update: (_value, transaction) => this.decorate(transaction.state),
      provide: field => [
        EditorView.decorations.from(field),
        EditorView.atomicRanges.of(view => view.state.field(field)),
      ],
    });
    this.state = EditorState.create({
      extensions: [
        mentionsField, decorations, this.historyConfig.of(history()),
        invertedEffects.of(transaction => transaction.docChanged || transaction.effects.some(effect => effect.is(setMentions))
          ? [setMentions.of(transaction.startState.field(mentionsField))] : []),
        keymap.of([
          { key: 'Enter', run: insertNewline, shift: insertNewline },
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
          // A replacement starts a new draft; old undo effects must not overwrite its chips.
          this.apply(this.state.update({
            changes: { from: 0, to: this.state.doc.length, insert: value },
            selection: { anchor: value.length },
            effects: [setMentions.of([]), this.historyConfig.reconfigure([])],
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
    this.element.replaceText = (from, to, text, filePath) => {
      const change = this.state.changes({ from, to, insert: text });
      const mapped = this.state.field(mentionsField).filter(mention => mention.to <= from || mention.from >= to)
        .map(mention => ({ ...mention, from: change.mapPos(mention.from, 1), to: change.mapPos(mention.to, -1) }));
      if (filePath) mapped.push({ from, to: from + text.trimEnd().length, path: filePath });
      this.apply(this.state.update({
        changes: change,
        selection: { anchor: from + text.length },
        effects: setMentions.of(mapped.sort((a, b) => a.from - b.from)),
        annotations: programmatic.of(true),
        userEvent: 'input.complete',
      }));
    };
    this.element.getFileMentions = () => this.state.field(mentionsField).map(mention => ({ ...mention }));
    this.element.setFileMentions = mentions => this.apply(this.state.update({
      effects: setMentions.of(mentions), annotations: Transaction.addToHistory.of(false),
    }));
    host.setAttribute('data-placeholder', this.placeholderText);
    host.addEventListener('focus', this.onFocus);
  }

  refreshMentions(): void {
    if (!this.destroyed) this.apply(this.state.update({ effects: refreshMentions.of(null) }));
  }

  destroy(): void {
    this.destroyed = true;
    this.element.removeEventListener('focus', this.onFocus);
    this.ariaObserver?.disconnect();
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
    return Decoration.set(state.field(mentionsField).map(mention => Decoration.replace({
      widget: new MentionWidget(mention, !this.isFileAvailable(mention.path), token => {
        this.element.replaceText!(token.from, token.to, '');
        this.view?.focus();
        this.emitInput();
      }, this.onOpenFile),
    }).range(mention.from, mention.to)), true);
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
