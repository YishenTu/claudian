import { BangBashModeManager } from '@/features/chat/ui/BangBashModeManager';

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
    isComposing: false,
    preventDefault: jest.fn(),
  } as any;
}

describe('BangBashModeManager', () => {
  it('should enter bash mode on ! keystroke when input is empty', () => {
    const wrapper = createWrapper();
    const inputEl = { value: '', placeholder: 'Ask...' } as any;
    const callbacks = {
      onSubmit: jest.fn().mockResolvedValue(undefined),
      getInputWrapper: () => wrapper,
    };

    const manager = new BangBashModeManager(inputEl, callbacks);
    const e = createKeyEvent('!');
    const handled = manager.handleTriggerKey(e);

    expect(handled).toBe(true);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(manager.isActive()).toBe(true);
    expect(wrapper.addClass).toHaveBeenCalledWith('claudian-input-bang-bash-mode');
  });

  it('should NOT enter bash mode on ! keystroke when input has content', () => {
    const wrapper = createWrapper();
    const inputEl = { value: 'hello', placeholder: 'Ask...' } as any;
    const callbacks = {
      onSubmit: jest.fn().mockResolvedValue(undefined),
      getInputWrapper: () => wrapper,
    };

    const manager = new BangBashModeManager(inputEl, callbacks);
    const e = createKeyEvent('!');
    const handled = manager.handleTriggerKey(e);

    expect(handled).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(manager.isActive()).toBe(false);
    expect(wrapper.addClass).not.toHaveBeenCalled();
  });

  it('should NOT enter bash mode when already active', () => {
    const wrapper = createWrapper();
    const inputEl = { value: '', placeholder: 'Ask...' } as any;
    const callbacks = {
      onSubmit: jest.fn().mockResolvedValue(undefined),
      getInputWrapper: () => wrapper,
    };

    const manager = new BangBashModeManager(inputEl, callbacks);
    manager.handleTriggerKey(createKeyEvent('!'));
    expect(manager.isActive()).toBe(true);

    // Try triggering again while active
    inputEl.value = '';
    const e = createKeyEvent('!');
    const handled = manager.handleTriggerKey(e);

    expect(handled).toBe(false);
  });

  it('should stay in bash mode when input is cleared (exit via Escape)', () => {
    const wrapper = createWrapper();
    const inputEl = { value: '', placeholder: 'Ask...' } as any;
    const callbacks = {
      onSubmit: jest.fn().mockResolvedValue(undefined),
      getInputWrapper: () => wrapper,
    };

    const manager = new BangBashModeManager(inputEl, callbacks);
    manager.handleTriggerKey(createKeyEvent('!'));
    expect(manager.isActive()).toBe(true);

    inputEl.value = '';
    manager.handleInputChange();

    expect(manager.isActive()).toBe(true);
    expect(wrapper.removeClass).not.toHaveBeenCalled();
  });

  it('should submit command on Enter and trim whitespace', async () => {
    const wrapper = createWrapper();
    const inputEl = { value: '', placeholder: 'Ask...' } as any;
    const callbacks = {
      onSubmit: jest.fn().mockResolvedValue(undefined),
      getInputWrapper: () => wrapper,
    };

    const manager = new BangBashModeManager(inputEl, callbacks);
    manager.handleTriggerKey(createKeyEvent('!'));

    inputEl.value = '  ls -la  ';
    manager.handleInputChange();

    const e = createKeyEvent('Enter');
    const handled = manager.handleKeydown(e);

    expect(handled).toBe(true);
    expect(e.preventDefault).toHaveBeenCalled();

    // Wait for async submit
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(callbacks.onSubmit).toHaveBeenCalledWith('ls -la');
  });

  it('should handle Enter when command is empty (no submit)', () => {
    const wrapper = createWrapper();
    const inputEl = { value: '', placeholder: 'Ask...' } as any;
    const callbacks = {
      onSubmit: jest.fn().mockResolvedValue(undefined),
      getInputWrapper: () => wrapper,
    };

    const manager = new BangBashModeManager(inputEl, callbacks);
    manager.handleTriggerKey(createKeyEvent('!'));

    inputEl.value = '   ';
    manager.handleInputChange();

    const e = createKeyEvent('Enter');
    const handled = manager.handleKeydown(e);

    expect(handled).toBe(true);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(callbacks.onSubmit).not.toHaveBeenCalled();
  });

  it('should cancel on Escape and clear input', () => {
    const wrapper = createWrapper();
    const inputEl = { value: '', placeholder: 'Ask...' } as any;
    const callbacks = {
      onSubmit: jest.fn().mockResolvedValue(undefined),
      getInputWrapper: () => wrapper,
    };

    const manager = new BangBashModeManager(inputEl, callbacks);
    manager.handleTriggerKey(createKeyEvent('!'));
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

    const manager = new BangBashModeManager(inputEl, callbacks);
    manager.handleTriggerKey(createKeyEvent('!'));
    expect(manager.isActive()).toBe(true);

    inputEl.value = 'some text';
    manager.handleInputChange();

    const e = createKeyEvent('a');
    const handled = manager.handleKeydown(e);

    expect(handled).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('should return raw command text via getRawCommand', () => {
    const wrapper = createWrapper();
    const inputEl = { value: '', placeholder: 'Ask...' } as any;
    const callbacks = {
      onSubmit: jest.fn().mockResolvedValue(undefined),
      getInputWrapper: () => wrapper,
    };

    const manager = new BangBashModeManager(inputEl, callbacks);
    manager.handleTriggerKey(createKeyEvent('!'));

    inputEl.value = 'npm test';
    manager.handleInputChange();

    expect(manager.getRawCommand()).toBe('npm test');
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

    const manager = new BangBashModeManager(inputEl, callbacks);
    manager.handleTriggerKey(createKeyEvent('!'));
    expect(manager.isActive()).toBe(true);

    inputEl.value = 'some command';
    manager.handleInputChange();

    manager.clear();

    expect(inputEl.value).toBe('');
    expect(manager.isActive()).toBe(false);
    expect(resetInputHeight).toHaveBeenCalled();
  });

  it('should remove bash mode class and restore placeholder on destroy()', () => {
    const wrapper = createWrapper();
    const inputEl = { value: '', placeholder: 'Ask...' } as any;
    const callbacks = {
      onSubmit: jest.fn().mockResolvedValue(undefined),
      getInputWrapper: () => wrapper,
    };

    const manager = new BangBashModeManager(inputEl, callbacks);
    manager.handleTriggerKey(createKeyEvent('!'));
    expect(manager.isActive()).toBe(true);

    manager.destroy();

    expect(wrapper.removeClass).toHaveBeenCalledWith('claudian-input-bang-bash-mode');
    expect(inputEl.placeholder).toBe('Ask...');
  });

  it('should not enter mode when wrapper is null', () => {
    const inputEl = { value: '', placeholder: 'Ask...' } as any;
    const callbacks = {
      onSubmit: jest.fn().mockResolvedValue(undefined),
      getInputWrapper: () => null,
    };

    const manager = new BangBashModeManager(inputEl, callbacks);
    const e = createKeyEvent('!');
    const handled = manager.handleTriggerKey(e);

    expect(handled).toBe(false);
    expect(manager.isActive()).toBe(false);
  });
});
