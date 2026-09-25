import type { ClaudianView } from '@/features/chat/ClaudianView';

/** Identifies a mounted chat view without relying on class identity across reloads. */
export function isClaudianView(value: unknown): value is ClaudianView {
  return !!value
    && typeof value === 'object'
    && typeof (value as { getTabManager?: unknown }).getTabManager === 'function';
}
