export function resolveCursorModelForCli(model: string | undefined): string | undefined {
  if (!model?.trim()) {
    return undefined;
  }
  const m = model.trim();
  if (m === 'composer-1') {
    return 'auto';
  }
  return m;
}
