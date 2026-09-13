/** Edits an Obsidian text control and commits it with the native Enter handler. */
export async function applyTextInput(
  text: {
    inputEl: unknown;
    onChangeCallback: ((value: string) => Promise<void> | void) | null;
  },
  value: string,
): Promise<void> {
  const input = text.inputEl as { value: string; addEventListener: jest.Mock };
  input.value = value;
  await text.onChangeCallback?.(value);
  const entry = input.addEventListener.mock.calls.find(([event]) => event === 'keydown');
  if (!entry) throw new Error('Input has no Enter handler');
  entry[1]({ key: 'Enter', isComposing: false, preventDefault() {} });
  await new Promise<void>(resolve => setImmediate(resolve));
}
