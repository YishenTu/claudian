import { type App, Modal } from 'obsidian';

import { commandNameFromPath } from '@/features/agent-skills/ClaudeCommandRepository';
import {
  type ClaudeSkillSync,
  type SkillSyncBlockingReason,
  type SkillSyncItem,
  type SkillSyncPlan,
  type SkillSyncResolution,
  type SkillSyncResult,
} from '@/features/agent-skills/ClaudeSkillSync';
import { t } from '@/i18n/i18n';

type ItemChoice = 'apply' | 'replace' | 'skip';

interface ItemDraft {
  choice: ItemChoice;
  name: string;
  description: string;
}

function problemText(reason: SkillSyncBlockingReason): string {
  if (reason.code === 'unreadable') return t('settings.skills.sync.problems.unreadable');
  if (reason.code === 'name-conflict') {
    return reason.with === 'shared'
      ? t('settings.skills.sync.problems.sharedConflict', { name: reason.name })
      : t('settings.skills.sync.problems.itemConflict', { name: reason.name });
  }
  return t(`settings.skills.sync.problems.${reason.field}`);
}

/** What a card offers; a card is rebuilt only when this grows. */
interface CardNeeds {
  name: boolean;
  description: boolean;
  replace: boolean;
  /** No fix is possible here (unreadable frontmatter or no instructions); only Keep or Discard. */
  unfixable: boolean;
}

function cardNeeds(reasons: SkillSyncBlockingReason[]): CardNeeds {
  return {
    name: reasons.some(reason => reason.code === 'name-conflict' || (reason.code === 'invalid' && reason.field === 'name')),
    description: reasons.some(reason => reason.code === 'invalid' && reason.field === 'description'),
    replace: reasons.some(reason => reason.code === 'name-conflict' && reason.with === 'shared'),
    unfixable: reasons.some(reason => reason.code === 'unreadable'
      || (reason.code === 'invalid' && reason.field === 'instructions')),
  };
}

function mergeNeeds(left: CardNeeds | undefined, right: CardNeeds): CardNeeds {
  if (!left) return right;
  return {
    name: left.name || right.name,
    description: left.description || right.description,
    replace: left.replace || right.replace,
    unfixable: left.unfixable || right.unfixable,
  };
}

function sameNeeds(left: CardNeeds | undefined, right: CardNeeds): boolean {
  return left !== undefined && left.name === right.name && left.description === right.description
    && left.replace === right.replace && left.unfixable === right.unfixable;
}

function itemLabel(item: SkillSyncItem): string {
  if (item.kind === 'command') {
    return `/${commandNameFromPath(item.id)}`;
  }
  return item.id.slice(item.id.lastIndexOf('/') + 1);
}

/**
 * Preview → final confirmation → result. Nothing on disk changes until the
 * user confirms the link step.
 */
export class SkillSyncModal extends Modal {
  private plan: SkillSyncPlan | null = null;
  private readonly drafts = new Map<string, ItemDraft>();

  constructor(
    app: App,
    private readonly sync: ClaudeSkillSync,
    /** Called after any attempt; `result` is null when Sync threw before finishing. */
    private readonly onFinished: (result: SkillSyncResult | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('claudian-skill-sync-modal');
    this.setTitle(t('settings.skills.sync.title'));
    this.contentEl.createEl('p', { text: t('settings.skills.sync.loading') });
    void this.#load();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  async #load(): Promise<void> {
    try {
      this.plan = await this.sync.plan();
    } catch (error) {
      this.#renderFailure(error);
      return;
    }
    for (const item of this.plan.items) {
      this.drafts.set(item.id, { choice: 'apply', name: item.proposedName, description: item.description });
    }
    if (this.plan.state === 'foreign-link' || this.plan.state === 'broken-link') {
      this.setTitle(t('settings.skills.sync.repairTitle'));
    }
    if (this.plan.items.length > 0) {
      this.#renderPreview();
    } else {
      this.#renderConfirm();
    }
  }

  #resolutions(): Map<string, SkillSyncResolution> {
    const resolutions = new Map<string, SkillSyncResolution>();
    for (const [id, draft] of this.drafts) {
      resolutions.set(id, draft.choice === 'skip'
        ? { action: 'skip' }
        : {
          action: 'apply',
          name: draft.name,
          description: draft.description,
          replaceExisting: draft.choice === 'replace',
        });
    }
    return resolutions;
  }

  #renderPreview(): void {
    const plan = this.plan!;
    this.contentEl.empty();

    this.contentEl.createEl('p', { text: t('settings.skills.sync.intro') });
    const points = this.contentEl.createEl('ul', { cls: 'claudian-skill-sync-points' });
    points.createEl('li', { cls: 'claudian-skill-sync-pro', text: t('settings.skills.sync.pros.oneList') });
    points.createEl('li', { cls: 'claudian-skill-sync-pro', text: t('settings.skills.sync.pros.newSkills') });
    points.createEl('li', { cls: 'claudian-skill-sync-con', text: t('settings.skills.sync.cons.dropped') });
    const syntaxNames = plan.items
      .filter(item => item.issues.some(issue => issue.code === 'claude-syntax'))
      .map(item => item.proposedName);
    if (syntaxNames.length > 0) {
      points.createEl('li', {
        cls: 'claudian-skill-sync-con',
        text: t('settings.skills.sync.cons.claudeSyntax', { names: syntaxNames.join(', ') }),
      });
    }

    this.contentEl.createEl('h3', { text: t('settings.skills.sync.attentionTitle') });
    const attentionEl = this.contentEl.createDiv({ cls: 'claudian-skill-sync-cards' });

    const actions = this.contentEl.createDiv({ cls: 'claudian-agent-skill-modal-actions' });
    const cancel = actions.createEl('button', {
      attr: { type: 'button' },
      text: t('common.cancel'),
      cls: 'claudian-cancel-btn',
    });
    cancel.addEventListener('click', () => this.close());
    const next = actions.createEl('button', {
      attr: { type: 'button' },
      text: t('settings.skills.sync.continue'),
      cls: 'mod-cta',
    });
    next.addEventListener('click', () => this.#renderConfirm());

    // Only items that need a decision get a card. An item joins once it blocks
    // (for example after another item is renamed onto its name) and then stays;
    // a card gains fields when a new problem needs them.
    const cards = new Map<string, (reasons: SkillSyncBlockingReason[]) => void>();
    const needs = new Map<string, CardNeeds>();
    let rendered = false;
    const update = (): void => {
      const blocking = this.sync.getBlockingReasons(plan, this.#resolutions());
      let grown = !rendered;
      for (const [id, reasons] of blocking) {
        const merged = mergeNeeds(needs.get(id), cardNeeds(reasons));
        if (!sameNeeds(needs.get(id), merged)) grown = true;
        needs.set(id, merged);
      }
      if (grown) {
        rendered = true;
        const focus = this.#captureFocus();
        attentionEl.empty();
        cards.clear();
        const listed = plan.items.filter(item => needs.has(item.id));
        if (listed.length === 0) {
          attentionEl.createEl('p', { text: t('settings.skills.sync.nothingNeedsAttention') });
        }
        listed.forEach((item, index) => {
          cards.set(item.id, this.#renderCard(attentionEl, item, index, needs.get(item.id)!, update));
        });
        focus();
      }
      for (const [id, refresh] of cards) refresh(blocking.get(id) ?? []);
      next.disabled = blocking.size > 0;
    };
    update();
  }

  /** Returns a callback that moves focus back to the same field after the cards are rebuilt. */
  #captureFocus(): () => void {
    const active = this.contentEl.ownerDocument.activeElement;
    if (!(active instanceof HTMLInputElement) || !active.dataset.field || !this.contentEl.contains(active)) {
      return () => undefined;
    }
    const { item, field } = active.dataset;
    const start = active.selectionStart;
    const end = active.selectionEnd;
    return () => {
      const input = [...this.contentEl.querySelectorAll<HTMLInputElement>('input[data-field]')]
        .find(candidate => candidate.dataset.item === item && candidate.dataset.field === field);
      input?.focus();
      if (input && start !== null && end !== null) input.setSelectionRange(start, end);
    };
  }

  /**
   * One card per item needing a decision: its problem, only the fields that
   * problem needs, and Fix / Replace / Skip choices. Returns a refresh callback.
   */
  #renderCard(
    container: HTMLElement,
    item: SkillSyncItem,
    index: number,
    needs: CardNeeds,
    onChange: () => void,
  ): (reasons: SkillSyncBlockingReason[]) => void {
    const draft = this.drafts.get(item.id)!;
    const card = container.createEl('fieldset', { cls: 'claudian-skill-sync-card' });
    card.createEl('legend', { text: itemLabel(item) });
    const status = card.createEl('p', { cls: 'claudian-skill-sync-status' });

    const fieldInputs: HTMLInputElement[] = [];
    const addField = (labelKey: 'nameField' | 'descriptionField', value: string, apply: (next: string) => void): void => {
      const label = card.createEl('label', { cls: 'claudian-skill-sync-field' });
      label.createSpan({ text: t(`settings.skills.sync.${labelKey}`) });
      const input = label.createEl('input', {
        attr: { type: 'text', 'data-item': item.id, 'data-field': labelKey },
      });
      input.value = value;
      input.addEventListener('input', () => {
        apply(input.value);
        onChange();
      });
      fieldInputs.push(input);
    };
    if (!needs.unfixable) {
      if (needs.name) addField('nameField', draft.name, value => { draft.name = value; });
      if (needs.description) addField('descriptionField', draft.description, value => { draft.description = value; });
    }

    const choices = card.createDiv({ cls: 'claudian-skill-sync-choices' });
    const options: Array<[ItemChoice, Parameters<typeof t>[0]]> = [];
    if (!needs.unfixable) options.push(['apply', 'settings.skills.sync.options.fix']);
    if (needs.replace && !needs.unfixable) options.push(['replace', 'settings.skills.sync.options.replace']);
    options.push(['skip', item.kind === 'command' ? 'settings.skills.sync.options.keep' : 'settings.skills.sync.options.discard']);
    for (const [value, labelKey] of options) {
      const label = choices.createEl('label');
      const radio = label.createEl('input', { attr: { type: 'radio', name: `claudian-skill-sync-${index}` } });
      radio.value = value;
      radio.checked = draft.choice === value;
      radio.addEventListener('change', () => {
        draft.choice = value;
        for (const input of fieldInputs) input.disabled = value !== 'apply';
        onChange();
      });
      label.appendText(` ${t(labelKey)}`);
    }
    for (const input of fieldInputs) input.disabled = draft.choice !== 'apply';

    return current => {
      const ready = current.length === 0;
      status.setText(ready ? t('settings.skills.sync.ready') : current.map(problemText).join(' '));
      status.toggleClass('claudian-skill-sync-status--ready', ready);
    };
  }

  #renderConfirm(): void {
    const plan = this.plan!;
    this.contentEl.empty();
    this.setTitle(t('settings.skills.sync.confirmTitle'));
    if (plan.state === 'foreign-link' || plan.state === 'broken-link') {
      this.contentEl.createEl('p', { text: t('settings.skills.sync.repairBody') });
    } else if (plan.state === 'missing' && plan.items.length === 0) {
      this.contentEl.createEl('p', { text: t('settings.skills.sync.linkBody') });
    } else if (plan.state === 'missing') {
      this.contentEl.createEl('p', { text: t('settings.skills.sync.linkWithItemsBody') });
    } else {
      this.contentEl.createEl('p', { text: t('settings.skills.sync.confirmBody') });
    }
    this.contentEl.createEl('p', {
      cls: 'claudian-agent-skill-warning',
      text: t('settings.skills.sync.devicesWarning'),
    });

    const actions = this.contentEl.createDiv({ cls: 'claudian-agent-skill-modal-actions' });
    const cancel = actions.createEl('button', {
      attr: { type: 'button' },
      text: t('common.cancel'),
      cls: 'claudian-cancel-btn',
    });
    cancel.addEventListener('click', () => this.close());
    const confirm = actions.createEl('button', {
      attr: { type: 'button' },
      text: t('settings.skills.sync.confirm'),
      cls: 'mod-warning',
    });
    confirm.addEventListener('click', () => {
      confirm.disabled = true;
      void this.#execute();
    });
  }

  async #execute(): Promise<void> {
    let result: SkillSyncResult;
    try {
      result = await this.sync.execute(this.plan!, this.#resolutions());
    } catch (error) {
      this.#renderFailure(error);
      this.onFinished(null);
      return;
    }
    this.onFinished(result);
    // Success needs no report: the Skills tab shows the synced indicator.
    if (result.linked && result.failed.length === 0) {
      this.close();
      return;
    }
    this.contentEl.empty();
    this.setTitle(t('settings.skills.sync.title'));
    this.contentEl.createEl('p', { text: t('settings.skills.sync.partial') });
    this.contentEl.createEl('p', {
      text: t('settings.skills.sync.summary', {
        moved: result.moved.length,
        converted: result.converted.length,
        trashed: result.trashed.length,
        unlinked: result.unlinked.length,
      }),
    });
    if (result.failed.length > 0) {
      const list = this.contentEl.createEl('ul', { cls: 'claudian-skill-sync-failures' });
      for (const failure of result.failed) {
        const item = list.createEl('li');
        item.createEl('code', { text: failure.id });
        item.appendText(` ${failure.message}`);
      }
    }
    this.#renderCloseButton();
  }

  #renderFailure(error: unknown): void {
    this.contentEl.empty();
    this.contentEl.createEl('p', {
      text: t('settings.skills.sync.failed', {
        message: error instanceof Error ? error.message : String(error),
      }),
    });
    this.#renderCloseButton();
  }

  #renderCloseButton(): void {
    const actions = this.contentEl.createDiv({ cls: 'claudian-agent-skill-modal-actions' });
    const close = actions.createEl('button', {
      attr: { type: 'button' },
      text: t('common.confirm'),
      cls: 'mod-cta',
    });
    close.addEventListener('click', () => this.close());
  }
}
