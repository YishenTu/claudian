const UNSAFE_TIMER_UNREF_PATTERNS = [
  {
    name: 'claude-sdk-process-transport-close',
    pattern: /if \(\$ && !\$\.killed && \$\.exitCode === null\) setTimeout\(\(X\) => \{\s*if \(X\.killed \|\| X\.exitCode !== null\) return;\s*X\.kill\("SIGTERM"\), setTimeout\(\(J\) => \{\s*if \(J\.exitCode === null\) J\.kill\("SIGKILL"\);\s*\}, 5e3, X\)\.unref\(\);\s*\}, M2, \$\)\.unref\(\), \$\.once\("exit", \(\) => mJ\.delete\(\$\)\);/g,
    replacement:
      'if ($ && !$.killed && $.exitCode === null) {' +
      '\n      const processKillTimer = setTimeout((X) => {' +
      '\n        if (X.killed || X.exitCode !== null) return;' +
      '\n        X.kill("SIGTERM");' +
      '\n        const forceKillTimer = setTimeout((J) => {' +
      '\n          if (J.exitCode === null) J.kill("SIGKILL");' +
      '\n        }, 5e3, X);' +
      '\n        forceKillTimer.unref?.();' +
      '\n      }, M2, $);' +
      '\n      processKillTimer.unref?.();' +
      '\n      $.once("exit", () => mJ.delete($));' +
      '\n    }',
  },
  {
    name: 'mcp-sdk-stdio-close-wait',
    pattern: /new Promise\(\((resolve\d+)\) => setTimeout\(\1, 2e3\)\.unref\(\)\)/g,
    replacement:
      'new Promise(($1) => {' +
      '\n        const closeTimeout = setTimeout($1, 2e3);' +
      '\n        closeTimeout.unref?.();' +
      '\n      })',
  },
];

const TIMER_CALL_PREFIXES = ['setTimeout(', 'setInterval('];

function patchRendererUnsafeUnrefSites(contents) {
  let nextContents = contents;
  const appliedPatches = [];

  for (const patch of UNSAFE_TIMER_UNREF_PATTERNS) {
    const matchCount = [...nextContents.matchAll(patch.pattern)].length;
    if (matchCount === 0) {
      continue;
    }
    nextContents = nextContents.replace(patch.pattern, patch.replacement);
    appliedPatches.push({ name: patch.name, count: matchCount });
  }

  return {
    contents: nextContents,
    appliedPatches,
  };
}

function findUnsafeTimerUnrefSites(contents) {
  const matches = [];

  let searchIndex = 0;
  while (searchIndex < contents.length) {
    const timerStart = findNextTimerCall(contents, searchIndex);
    if (!timerStart) {
      break;
    }

    const callEnd = findMatchingParen(contents, timerStart.openParenIndex);
    if (callEnd === -1) {
      searchIndex = timerStart.startIndex + timerStart.prefix.length;
      continue;
    }

    const unrefMatch = contents.slice(callEnd + 1).match(/^\s*\.unref\(\)/);
    if (unrefMatch) {
      const startIndex = timerStart.startIndex;
      const endIndex = callEnd + 1 + unrefMatch[0].length;
      const line = contents.slice(0, startIndex).split('\n').length;
      matches.push({
        line,
        snippet: contents.slice(startIndex, endIndex),
      });
      searchIndex = endIndex;
      continue;
    }

    searchIndex = callEnd + 1;
  }

  return matches;
}

function findNextTimerCall(contents, startIndex) {
  let nextMatch = null;

  for (const prefix of TIMER_CALL_PREFIXES) {
    const index = contents.indexOf(prefix, startIndex);
    if (index === -1) {
      continue;
    }
    if (!nextMatch || index < nextMatch.startIndex) {
      nextMatch = {
        prefix,
        startIndex: index,
        openParenIndex: index + prefix.length - 1,
      };
    }
  }

  return nextMatch;
}

function findMatchingParen(contents, openParenIndex) {
  let depth = 1;
  let quote = null;

  for (let index = openParenIndex + 1; index < contents.length; index += 1) {
    const char = contents[index];

    if (quote) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === '\'' || char === '`') {
      quote = char;
      continue;
    }

    if (char === '(') {
      depth += 1;
      continue;
    }

    if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

module.exports = {
  findUnsafeTimerUnrefSites,
  patchRendererUnsafeUnrefSites,
};
