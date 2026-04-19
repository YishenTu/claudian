import * as rendererSafeUnrefHelpers from '../../../scripts/rendererSafeUnref.js';

const {
  findUnsafeTimerUnrefSites,
  patchRendererUnsafeUnrefSites,
} = rendererSafeUnrefHelpers;

describe('rendererSafeUnref helpers', () => {
  it('patches the known unsafe timer .unref() bundle sites', () => {
    const input = [
      'if ($ && !$.killed && $.exitCode === null) setTimeout((X) => {',
      '  if (X.killed || X.exitCode !== null) return;',
      '  X.kill("SIGTERM"), setTimeout((J) => {',
      '    if (J.exitCode === null) J.kill("SIGKILL");',
      '  }, 5e3, X).unref();',
      '}, M2, $).unref(), $.once("exit", () => mJ.delete($));',
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
