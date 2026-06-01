import * as rendererSafeUnrefHelpers from '../../../scripts/rendererSafeUnref.js';

const {
  findUnsafeTimerUnrefSites,
  patchRendererUnsafeUnrefSites,
} = rendererSafeUnrefHelpers;

describe('rendererSafeUnref helpers', () => {
  it('patches the known unsafe timer .unref() bundle sites', () => {
    const input = [
      'if ($ && !$.killed && $.exitCode === null) setTimeout((Q) => {',
      '  if (Q.killed || Q.exitCode !== null) return;',
      '  Q.kill("SIGTERM"), setTimeout((J) => {',
      '    if (J.exitCode === null) J.kill("SIGKILL");',
      '  }, 5e3, Q).unref();',
      '}, wx, $).unref(), $.once("exit", () => D5.delete($));',
      'await Promise.race([closePromise, new Promise((resolve5) => setTimeout(resolve5, 2e3).unref())]);',
    ].join('\n');

    const result = patchRendererUnsafeUnrefSites(input);

    expect(result.appliedPatches).toEqual([
      { name: 'claude-sdk-process-transport-close', count: 1 },
      { name: 'mcp-sdk-stdio-close-wait', count: 1 },
    ]);
    expect(result.contents).toContain('processKillTimer.unref?.();');
    expect(result.contents).toContain('forceKillTimer.unref?.();');
    expect(result.contents).toContain('closeTimeout.unref?.();');
    expect(findUnsafeTimerUnrefSites(result.contents)).toEqual([]);
  });

  it('patches the current claude-sdk shape with a block-bodied exit handler', () => {
    const input = [
      'if ($ && !$.killed && $.exitCode === null) setTimeout((X) => {',
      '  if (X.killed || X.exitCode !== null) return;',
      '  X.kill("SIGTERM"), setTimeout((J) => {',
      '    if (J.exitCode === null) J.kill("SIGKILL");',
      '  }, 5e3, X).unref();',
      '}, LM, $).unref(), $.once("exit", () => {',
      '  if (this.processExitHandler) process.off("exit", this.processExitHandler), this.processExitHandler = void 0;',
      '});',
      'else if (this.processExitHandler) process.off("exit", this.processExitHandler), this.processExitHandler = void 0;',
    ].join('\n');

    const result = patchRendererUnsafeUnrefSites(input);

    expect(result.appliedPatches).toEqual([
      { name: 'claude-sdk-process-transport-close', count: 1 },
    ]);
    expect(result.contents).toContain('processKillTimer.unref?.();');
    expect(result.contents).toContain('forceKillTimer.unref?.();');
    expect(result.contents).toContain('this.processExitHandler');
    expect(findUnsafeTimerUnrefSites(result.contents)).toEqual([]);
  });

  it('patches the latest claude-sdk async close callback shape', () => {
    const input = [
      'if (Q && !Q.killed && Q.exitCode === null) setTimeout((J, Y) => {',
      '  if (J.exitCode !== null) {',
      '    Y();',
      '    return;',
      '  }',
      '  if (process.platform === "win32") {',
      '    setTimeout((X, W) => {',
      '      if (X.exitCode === null) X.kill("SIGKILL");',
      '      W();',
      '    }, 5e3, J, Y).unref();',
      '    return;',
      '  }',
      '  J.kill("SIGTERM"), setTimeout((X) => {',
      '    if (X.exitCode === null) X.kill("SIGKILL");',
      '  }, 5e3, J).unref(), Y();',
      '}, Tx, Q, $).unref(), Q.once("exit", () => VX.delete(Q));',
    ].join('\n');

    const result = patchRendererUnsafeUnrefSites(input);

    expect(result.appliedPatches).toEqual([
      { name: 'claude-sdk-process-transport-close-async', count: 1 },
    ]);
    expect(result.contents).toContain('processKillTimer.unref?.();');
    expect(result.contents).toContain('windowsForceKillTimer.unref?.();');
    expect(result.contents).toContain('forceKillTimer.unref?.();');
    expect(findUnsafeTimerUnrefSites(result.contents)).toEqual([]);
  });

  it('reports remaining direct timer .unref() calls but ignores guarded usage', () => {
    const input = [
      'const timer = setTimeout(run, 1000);',
      'timer.unref?.();',
      'if (timer.unref) timer.unref();',
      'setTimeout(run, 1000).unref();',
      'setInterval(run, 1000).unref();',
    ].join('\n');

    expect(findUnsafeTimerUnrefSites(input)).toEqual([
      { line: 4, snippet: 'setTimeout(run, 1000).unref()' },
      { line: 5, snippet: 'setInterval(run, 1000).unref()' },
    ]);
  });
});
