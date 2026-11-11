/** Keep a native control aligned with the serialized settings owner's committed snapshot. */
export function bindCommittedControl<T>(
  control: { setValue(value: T): unknown; onChange(callback: (value: T) => Promise<void>): unknown },
  getValue: () => T,
  save: (value: T) => Promise<void>,
  onChanged?: () => void,
): void {
  let synchronizing = false;
  let displayed = getValue();
  control.setValue(displayed);
  control.onChange(async value => {
    if (synchronizing) return;
    const previous = displayed;
    try {
      await save(value);
    } finally {
      synchronizing = true;
      try {
        displayed = getValue();
        control.setValue(displayed);
      } finally {
        synchronizing = false;
      }
      if (displayed !== previous) onChanged?.();
    }
  });
}
