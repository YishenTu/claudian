import {
  buildCursorAgentFlagArgs,
  buildCursorAgentJsonModeFlagArgs,
} from '@/providers/cursor/runtime/cursorLaunchArgs';

describe('cursorLaunchArgs', () => {
  const workspace = '/vault';

  it('builds stream-json argv with trust and sandbox for normal mode', () => {
    const args = buildCursorAgentFlagArgs({
      workspaceDir: workspace,
      permissionMode: 'normal',
      resumeSessionId: null,
    });
    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--stream-partial-output');
    expect(args).toContain('--workspace');
    expect(args).toContain(workspace);
    expect(args).toContain('--trust');
    expect(args).toContain('--sandbox');
    expect(args).toContain('enabled');
  });

  it('adds force and disabled sandbox for yolo', () => {
    const args = buildCursorAgentFlagArgs({
      workspaceDir: workspace,
      permissionMode: 'yolo',
    });
    expect(args).toContain('--force');
    expect(args).toContain('disabled');
  });

  it('adds plan mode for plan permission', () => {
    const args = buildCursorAgentFlagArgs({
      workspaceDir: workspace,
      permissionMode: 'plan',
    });
    expect(args).toContain('--mode');
    expect(args).toContain('plan');
  });

  it('appends resume and model when provided', () => {
    const args = buildCursorAgentFlagArgs({
      workspaceDir: workspace,
      permissionMode: 'normal',
      model: 'composer-2-fast',
      resumeSessionId: 'sess-1',
    });
    expect(args).toContain('--resume');
    expect(args).toContain('sess-1');
    expect(args).toContain('--model');
    expect(args).toContain('composer-2-fast');
  });

  it('json mode omits stream partial flags', () => {
    const args = buildCursorAgentJsonModeFlagArgs({
      workspaceDir: workspace,
      permissionMode: 'normal',
    });
    expect(args).toContain('--output-format');
    expect(args).toContain('json');
    expect(args).not.toContain('stream-json');
    expect(args).not.toContain('--stream-partial-output');
  });
});
