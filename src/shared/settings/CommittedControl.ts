/** Keep a native control aligned with the serialized settings owner's committed snapshot. */
export function bindCommittedControl<T>(
  control: { setValue(value: T): unknown; onChange(callback: (value: T) => Promise<void>): unknown },
  getValue: () => T,
  save: (value: T) => Promise<void>,
  onChanged?: () => void,
): void {
  let synchronizing = false;
  control.setValue(getValue());
  control.onChange(async value => {
    if (synchronizing) return;
    const previous = getValue();
    try {
      await save(value);
    } finally {
      synchronizing = true;
      try {
        control.setValue(getValue());
      } finally {
        synchronizing = false;
      }
      if (getValue() !== previous) onChanged?.();
    }
  });
}
