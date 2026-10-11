import type { SubagentInfo, SubagentProgress } from '@/core/types';
import {
  type AsyncSubagentState,
  createAsyncSubagentBlock,
  createSubagentBlock,
  type SubagentState,
  updateAsyncSubagentBlock,
  updateSubagentBlock,
  updateSubagentProgress,
} from '@/features/chat/subagents/SubagentRenderer';

/** Disposable card presentation. Task identity and lifecycle stay with SubagentManager. */
export class SubagentCardView {
  private readonly cards = new Map<string, SubagentState | AsyncSubagentState>();
  private readonly pendingParents = new Map<string, HTMLElement>();

  reserve(id: string, parent: HTMLElement | null): void {
    if (parent) this.pendingParents.set(id, parent);
  }

  getElement(id: string): HTMLElement | undefined { return this.cards.get(id)?.wrapperEl; }

  render(info: SubagentInfo, parentEl?: HTMLElement | null, previousEl?: HTMLElement): void {
    const existing = this.cards.get(info.id);
    if (existing && (!previousEl || previousEl === existing.wrapperEl)
      && (existing.info.mode ?? 'sync') === (info.mode ?? 'sync')) {
      if (info.mode === 'async') updateAsyncSubagentBlock(existing as AsyncSubagentState, info);
      else updateSubagentBlock(existing, info);
      return;
    }
    const previous = previousEl ?? existing?.wrapperEl;
    const parent = previous?.parentElement ?? parentEl ?? this.pendingParents.get(info.id);
    if (!parent) return;
    // A failed card must not prevent recording the task or its children.
    try {
      const view = info.mode === 'async' ? createAsyncSubagentBlock(parent, info) : createSubagentBlock(parent, info);
      if (previous?.parentElement === parent) parent.insertBefore(view.wrapperEl, previous);
      previous?.remove();
      this.cards.set(info.id, view);
      this.pendingParents.delete(info.id);
    } catch { /* A later presentation can render the retained model. */ }
  }

  progress(progress: SubagentProgress): void {
    const view = this.cards.get(progress.toolCallId);
    if (view) updateSubagentProgress(view, progress);
  }

  release(id: string): void {
    this.cards.delete(id);
    this.pendingParents.delete(id);
  }

  clear(): void {
    this.cards.clear();
    this.pendingParents.clear();
  }
}
