import { addIcon } from 'obsidian';

export const SESSION_COLLAPSE_ALL_ICON = 'claudian-list-chevrons-down-up';
export const SESSION_EXPAND_ALL_ICON = 'claudian-list-chevrons-up-down';

let registered = false;

export function registerSessionManagerIcons(): void {
  if (registered) return;
  registered = true;

  addIcon(
    SESSION_COLLAPSE_ALL_ICON,
    '<path d="M3 5h8"/><path d="M3 12h8"/><path d="M3 19h8"/>'
      + '<path d="m15 5 3 3 3-3"/><path d="m15 19 3-3 3 3"/>',
  );
  addIcon(
    SESSION_EXPAND_ALL_ICON,
    '<path d="M3 5h8"/><path d="M3 12h8"/><path d="M3 19h8"/>'
      + '<path d="m15 8 3-3 3 3"/><path d="m15 16 3 3 3-3"/>',
  );
}
