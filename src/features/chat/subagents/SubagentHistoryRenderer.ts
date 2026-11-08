import type { ChatMessage, SubagentInfo, ToolCallInfo } from '@/core/types';
import { setupDisclosureButton } from '@/features/chat/rendering/collapsible';
import { createSubagentBlock } from '@/features/chat/subagents/SubagentRenderer';
import { t } from '@/i18n/i18n';

let nextHistoryId = 0;

function previousRuns(messages: ChatMessage[], info: SubagentInfo): ToolCallInfo[] {
  // Native agent identity links runs of a reused subagent across separate cards.
  if (!info.agentId) return [];
  const runs: ToolCallInfo[] = [];
  for (const message of messages) {
    if (message.isRebuiltContext) continue;
    for (const tool of message.toolCalls ?? []) {
      if (tool.id === info.id) return runs;
      if (tool.subagent?.agentId === info.agentId) {
        runs.push(tool);
      }
    }
  }
  return [];
}

function createDisclosure(parent: HTMLElement, label: string, render: (body: HTMLElement) => void): void {
  const section = parent.createDiv({ cls: 'claudian-subagent-section' });
  const id = `claudian-subagent-history-${nextHistoryId++}`;
  const toggle = section.createEl('button', { cls: 'claudian-subagent-history-toggle', text: label });
  const body = section.createDiv({ cls: 'claudian-subagent-section-body', attr: { id } });
  setupDisclosureButton(toggle, body, { onFirstExpand: () => render(body) });
}

/** View-only history: earlier cards stay authoritative, and copies are rendered only on demand. */
export function renderSubagentHistory(
  card: HTMLElement, info: SubagentInfo, messages: ChatMessage[],
): void {
  const content = card.querySelector<HTMLElement>('.claudian-subagent-content');
  if (!content) return;
  const existing = content.querySelector<HTMLElement>(':scope > .claudian-subagent-history');
  if (existing) {
    // Move new current-run content before history without detaching its focused controls.
    while (existing.nextElementSibling) content.insertBefore(existing.nextElementSibling, existing);
    return;
  }
  const runs = previousRuns(messages, info);
  if (!runs.length) return;
  const history = content.createDiv({ cls: 'claudian-subagent-history' });
  createDisclosure(history, t('chat.subagentUI.previousRuns', { count: runs.length }), body => {
    runs.forEach((run, index) => {
      const status = run.subagent!.status;
      const label = t(`chat.subagentUI.${status}`);
      createDisclosure(body, t('chat.subagentUI.runLabel', { number: index + 1, status: label }), runBody => {
        const view = createSubagentBlock(runBody, run.subagent!);
        // These are passive details, not another live card.
        delete view.wrapperEl.dataset.subagentId;
        view.headerEl.click();
        view.headerEl.remove();
        for (const section of [view.promptSectionEl, view.resultSectionEl]) {
          if (section && !section.hidden) section.querySelector<HTMLElement>('.claudian-subagent-section-header')?.click();
        }
      });
    });
  });
}
