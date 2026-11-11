import * as rendererSafeUnrefHelpers from '../../../scripts/rendererSafeUnref.js';

const {
  findUnsafeTimerUnrefSites,
  patchRendererUnsafeUnrefSites,
} = rendererSafeUnrefHelpers;

describe('rendererSafeUnref helpers', () => {
  it.each([
    {
      shape: 'nested SDK process-close timers with an MCP close wait',
      timerUnrefs: 3,
      input: [
        'if ($ && !$.killed && $.exitCode === null) setTimeout((Q) => {',
        '  if (Q.killed || Q.exitCode !== null) return;',
        '  Q.kill("SIGTERM"), setTimeout((J) => {',
        '    if (J.exitCode === null) J.kill("SIGKILL");',
        '  }, 5e3, Q).unref();',
        '}, wx, $).unref(), $.once("exit", () => D5.delete($));',
        'await Promise.race([closePromise, new Promise((resolve5) => setTimeout(resolve5, 2e3).unref())]);',
      ].join('\n'),
    },
    {
      shape: 'SDK process-close timers followed by a block-bodied exit handler',
      timerUnrefs: 2,
      input: [
        'if ($ && !$.killed && $.exitCode === null) setTimeout((X) => {',
        '  if (X.killed || X.exitCode !== null) return;',
        '  X.kill("SIGTERM"), setTimeout((J) => {',
        '    if (J.exitCode === null) J.kill("SIGKILL");',
        '  }, 5e3, X).unref();',
        '}, LM, $).unref(), $.once("exit", () => {',
        '  if (this.processExitHandler) process.off("exit", this.processExitHandler), this.processExitHandler = void 0;',
        '});',
        'else if (this.processExitHandler) process.off("exit", this.processExitHandler), this.processExitHandler = void 0;',
      ].join('\n'),
    },
    {
      shape: 'SDK async close callback with a Windows force-kill timer',
      timerUnrefs: 3,
      input: [
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
      ].join('\n'),
    },
    {
      shape: 'minified timers',
      timerUnrefs: 2,
      input: [
        'setTimeout((i,o)=>{i.exitCode===null&&i.kill("SIGKILL"),o()},5e3,n,e).unref();',
        'new Promise(i=>setTimeout(i,2e3).unref())',
      ].join(''),
    },
  ])('guards every timer .unref() in $shape and changes nothing else', ({ input, timerUnrefs }) => {
    expect(findUnsafeTimerUnrefSites(input)).toHaveLength(timerUnrefs);

    const result = patchRendererUnsafeUnrefSites(input);

    expect(result.guardedCount).toBe(timerUnrefs);
    // Every .unref() in these fixtures follows a timer call, so a plain replacement is the expected output.
    expect(result.contents).toBe(input.replaceAll('.unref()', '.unref?.()'));
    expect(findUnsafeTimerUnrefSites(result.contents)).toEqual([]);
  });

  it('reports and guards only direct timer .unref() calls', () => {
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
    expect(patchRendererUnsafeUnrefSites(input)).toEqual({
      guardedCount: 2,
      contents: [
        'const timer = setTimeout(run, 1000);',
        'timer.unref?.();',
        'if (timer.unref) timer.unref();',
        'setTimeout(run, 1000).unref?.();',
        'setInterval(run, 1000).unref?.();',
      ].join('\n'),
    });
  });
});
