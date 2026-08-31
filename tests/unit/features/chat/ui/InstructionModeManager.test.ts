import { InstructionModeManager } from '@/features/chat/ui/InstructionModeManager';

function createHarness() {
  const wrapper = {
    addClass: jest.fn(),
    removeClass: jest.fn(),
  } as any;
  const inputEl = {
    focus: jest.fn(),
    placeholder: 'Ask...',
    value: '',
  } as any;
  const callbacks = {
    getInputWrapper: () => wrapper,
    onActiveChange: jest.fn(),
    onSubmit: jest.fn().mockResolvedValue(undefined),
  };
  return {
    callbacks,
    inputEl,
    manager: new InstructionModeManager(inputEl, callbacks),
    wrapper,
  };
}

function key(keyValue: string, options: { shiftKey?: boolean } = {}) {
  return {
    isComposing: false,
    key: keyValue,
    preventDefault: jest.fn(),
    shiftKey: options.shiftKey ?? false,
  } as any;
}

describe('InstructionModeManager', () => {
  it('enters only through the explicit entry point', () => {
    const { callbacks, inputEl, manager, wrapper } = createHarness();

    expect(manager.enter()).toBe(true);
    expect(manager.isActive()).toBe(true);
    expect(inputEl.placeholder).toBe('Save in custom system prompt');
    expect(inputEl.focus).toHaveBeenCalled();
    expect(wrapper.addClass).toHaveBeenCalledWith('claudian-input-instruction-mode');
    expect(callbacks.onActiveChange).toHaveBeenCalledWith(true);
  });

  it('does not infer instruction mode from typed or pasted hash text', () => {
    const { inputEl, manager, wrapper } = createHarness();
    inputEl.value = '# hello';

    manager.handleInputChange();

    expect(manager.isActive()).toBe(false);
    expect(wrapper.addClass).not.toHaveBeenCalled();
  });

  it('tracks and submits a trimmed instruction', () => {
    const { callbacks, inputEl, manager } = createHarness();
    manager.enter();
    inputEl.value = '  test  ';
    manager.handleInputChange();
    const event = key('Enter');

    expect(manager.handleKeydown(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(callbacks.onSubmit).toHaveBeenCalledWith('test');
  });

  it('exits when the input is cleared', () => {
    const { callbacks, inputEl, manager, wrapper } = createHarness();
    manager.enter();
    manager.handleInputChange();

    expect(manager.isActive()).toBe(false);
    expect(inputEl.placeholder).toBe('Ask...');
    expect(wrapper.removeClass).toHaveBeenCalledWith('claudian-input-instruction-mode');
    expect(callbacks.onActiveChange).toHaveBeenLastCalledWith(false);
  });

  it('cancels on Escape and clears input', () => {
    const { inputEl, manager } = createHarness();
    manager.enter();
    inputEl.value = 'hello';
    manager.handleInputChange();
    const event = key('Escape');

    expect(manager.handleKeydown(event)).toBe(true);
    expect(inputEl.value).toBe('');
    expect(manager.isActive()).toBe(false);
  });

  it('cleans presentation state on destroy', () => {
    const { inputEl, manager, wrapper } = createHarness();
    manager.enter();

    manager.destroy();

    expect(wrapper.removeClass).toHaveBeenCalledWith('claudian-input-instruction-mode');
    expect(inputEl.placeholder).toBe('Ask...');
  });
});
