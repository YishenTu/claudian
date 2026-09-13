/** Frame each existing heading and its following siblings without rebuilding controls. */
export function frameSettingsGroups(container: HTMLElement): void {
  let body: HTMLElement | null = null;
  for (const child of Array.from(container.children)) {
    if (child.classList.contains('setting-item-heading')) {
      const group = container.createDiv({ cls: 'claudian-settings-group' });
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', child.textContent?.trim() ?? '');
      container.insertBefore(group, child);
      group.appendChild(child);
      body = group.createDiv({ cls: 'claudian-settings-group-body' });
    } else if (body) {
      body.appendChild(child);
    }
  }
}
