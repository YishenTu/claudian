import { InstructionModeManager } from '@/features/chat/ui/InstructionModeManager';

function createWrapper() {
  return {
    addClass: jest.fn(),
    removeClass: jest.fn(),
  } as any;
}

function createKeyEvent(key: string, options: { shiftKey?: boolean } = {}) {
  return {
    key,
    shiftKey: options.shiftKey ?? false,
    preventDefault: jest.fn(),
  } as any;
}

describe('InstructionModeManager', () => {
  it('should enter instruction mode on # keystroke when input is empty', () => {
    const wrapper = createWrapper();
    const inputEl = { value: '', placeholder: 'Ask...' } as any;
    const callbacks = {
      onSubmit: jest.fn().mockResolvedValue(undefined),
      getInputWrapper: () => wrapper,
    };

    const manager = new InstructionModeManager(inputEl, callbacks);
    const e = createKeyEvent('#');
    const handled = manager.handleTriggerKey(e);

    expect(handled).toBe(true);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(manager.isActive()).toBe(true);
    expect(inputEl.placeholder).toBe('# Save in custom system prompt');
    expect(wrapper.addClass).toHaveBeenCalledWith('claudian-input-instruction-mode');
  });

  it('should NOT enter instruction mode on # keystroke when input has content', () => {
    const wrapper = createWrapper();
    const inputEl = { value: 'hello', placeholder: 'Ask...' } as any;
    const callbacks = {
      onSubmit: jest.fn().mockResolvedValue(undefined),
      getInputWrapper: () => wrapper,
    };

    const manager = new InstructionModeManager(inputEl, callbacks);
    const e = createKeyEvent('#');
    const handled = manager.handleTriggerKey(e);

    expect(handled).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(manager.isActive()).toBe(false);
    expect(wrapper.addClass).not.toHaveBeenCalled();
  });

  it('should NOT enter instruction mode when pasting "# hello"', () => {
    const wrapper = createWrapper();
    const inputEl = { value: '', placeholder: 'Ask...' } as any;
    const callbacks = {
      onSubmit: jest.fn().mockResolvedValue(undefined),
      getInputWrapper: () => wrapper,
    };

    const manager = new InstructionModeManager(inputEl, callbacks);

    // Simulate paste - no keystroke, just input change
    inputEl.value = '# hello';
    manager.handleInputChange();

    expect(manager.isActive()).toBe(false);
    expect(wrapper.addClass).not.toHaveBeenCalled();
  });

  it('should exit instruction mode when input is cleared', () => {
    const wrapper = createWrapper();
    const inputEl = { value: '', placeholder: 'Ask...' } as any;
    const callbacks = {
      onSubmit: jest.fn().mockResolvedValue(undefined),
      getInputWrapper: () => wrapper,
    };

    const manager = new InstructionModeManager(inputEl, callbacks);
    manager.handleTriggerKey(createKeyEvent('#'));
    expect(manager.isActive()).toBe(true);

    inputEl.value = '';
    manager.handleInputChange();

    expect(manager.isActive()).toBe(false);
    expect(inputEl.placeholder).toBe('Ask...');
    expect(wrapper.removeClass).toHaveBeenCalledWith('claudian-input-instruction-mode');
  });

  it('should submit instruction on Enter (without Shift) and trim whitespace', async () => {
    const wrapper = createWrapper();
    const inputEl = { value: '', placeholder: 'Ask...' } as any;
    const callbacks = {
      onSubmit: jest.fn().mockResolvedValue(undefined),
      getInputWrapper: () => wrapper,
    };

    const manager = new InstructionModeManager(inputEl, callbacks);
    manager.handleTriggerKey(createKeyEvent('#'));

    inputEl.value = '  test  ';
    manager.handleInputChange();

    const e = createKeyEvent('Enter');
    const handled = manager.handleKeydown(e);

    expect(handled).toBe(true);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(callbacks.onSubmit).toHaveBeenCalledWith('test');
  });

  it('should not handle Enter when instruction is empty', () => {
    const wrapper = createWrapper();
    const inputEl = { value: '', placeholder: 'Ask...' } as any;
    const callbacks = {
      onSubmit: jest.fn().mockResolvedValue(undefined),
      getInputWrapper: () => wrapper,
    };

    const manager = new InstructionModeManager(inputEl, callbacks);
    manager.handleTriggerKey(createKeyEvent('#'));

    inputEl.value = '   ';
    manager.handleInputChange();

    const e = createKeyEvent('Enter');
    const handled = manager.handleKeydown(e);

    expect(handled).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(callbacks.onSubmit).not.toHaveBeenCalled();
  });

  it('should cancel on Escape and clear input', () => {
    const wrapper = createWrapper();
    const inputEl = { value: '', placeholder: 'Ask...' } as any;
    const callbacks = {
      onSubmit: jest.fn().mockResolvedValue(undefined),
      getInputWrapper: () => wrapper,
    };

    const manager = new InstructionModeManager(inputEl, callbacks);
    manager.handleTriggerKey(createKeyEvent('#'));
    expect(manager.isActive()).toBe(true);

    inputEl.value = 'hello';
    manager.handleInputChange();

    const e = createKeyEvent('Escape');
    const handled = manager.handleKeydown(e);

    expect(handled).toBe(true);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(inputEl.value).toBe('');
    expect(manager.isActive()).toBe(false);
  });

  it('should return false for non-Enter/Escape keys when active', () => {
    const wrapper = createWrapper();
    const inputEl = { value: '', placeholder: 'Ask...' } as any;
    const callbacks = {
      onSubmit: jest.fn().mockResolvedValue(undefined),
      getInputWrapper: () => wrapper,
    };

    const manager = new InstructionModeManager(inputEl, callbacks);
    manager.handleTriggerKey(createKeyEvent('#'));
    expect(manager.isActive()).toBe(true);

    inputEl.value = 'some text';
    manager.handleInputChange();

    const e = createKeyEvent('a');
    const handled = manager.handleKeydown(e);

    expect(handled).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('should return raw instruction text via getRawInstruction', () => {
    const wrapper = createWrapper();
    const inputEl = { value: '', placeholder: 'Ask...' } as any;
    const callbacks = {
      onSubmit: jest.fn().mockResolvedValue(undefined),
      getInputWrapper: () => wrapper,
    };

    const manager = new InstructionModeManager(inputEl, callbacks);
    manager.handleTriggerKey(createKeyEvent('#'));

    inputEl.value = 'my instruction';
    manager.handleInputChange();

    expect(manager.getRawInstruction()).toBe('my instruction');
  });

  it('should clear input, exit mode and reset input height on clear()', () => {
    const wrapper = createWrapper();
    const inputEl = { value: '', placeholder: 'Ask...' } as any;
    const resetInputHeight = jest.fn();
    const callbacks = {
      onSubmit: jest.fn().mockResolvedValue(undefined),
      getInputWrapper: () => wrapper,
      resetInputHeight,
    };

    const manager = new InstructionModeManager(inputEl, callbacks);
    manager.handleTriggerKey(createKeyEvent('#'));
    expect(manager.isActive()).toBe(true);

    inputEl.value = 'instruction text';
    manager.handleInputChange();

    manager.clear();

    expect(inputEl.value).toBe('');
    expect(manager.isActive()).toBe(false);
    expect(resetInputHeight).toHaveBeenCalled();
  });

  it('should remove instruction mode class and restore placeholder on destroy()', () => {
    const wrapper = createWrapper();
    const inputEl = { value: '', placeholder: 'Ask...' } as any;
    const callbacks = {
      onSubmit: jest.fn().mockResolvedValue(undefined),
      getInputWrapper: () => wrapper,
    };

    const manager = new InstructionModeManager(inputEl, callbacks);
    manager.handleTriggerKey(createKeyEvent('#'));
    expect(manager.isActive()).toBe(true);
    expect(inputEl.placeholder).toBe('# Save in custom system prompt');

    manager.destroy();

    expect(wrapper.removeClass).toHaveBeenCalledWith('claudian-input-instruction-mode');
    expect(inputEl.placeholder).toBe('Ask...');
  });
});
