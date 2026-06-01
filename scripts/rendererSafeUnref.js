const JS_IDENTIFIER = '[A-Za-z_$][A-Za-z0-9_$]*';

const UNSAFE_TIMER_UNREF_PATTERNS = [
  {
    name: 'claude-sdk-process-transport-close-async',
    pattern: new RegExp(
      `if \\((${JS_IDENTIFIER}) && !\\1\\.killed && \\1\\.exitCode === null\\) setTimeout\\(\\((${JS_IDENTIFIER}), (${JS_IDENTIFIER})\\) => \\{\\s*` +
      `if \\(\\2\\.exitCode !== null\\) \\{\\s*` +
      `\\3\\(\\);\\s*` +
      `return;\\s*` +
      `\\}\\s*` +
      `if \\(process\\.platform === "win32"\\) \\{\\s*` +
      `setTimeout\\(\\((${JS_IDENTIFIER}), (${JS_IDENTIFIER})\\) => \\{\\s*` +
      `if \\(\\4\\.exitCode === null\\) \\4\\.kill\\("SIGKILL"\\);\\s*` +
      `\\5\\(\\);\\s*` +
      `\\}, 5e3, \\2, \\3\\)\\.unref\\(\\);\\s*` +
      `return;\\s*` +
      `\\}\\s*` +
      `\\2\\.kill\\("SIGTERM"\\), setTimeout\\(\\((${JS_IDENTIFIER})\\) => \\{\\s*` +
      `if \\(\\6\\.exitCode === null\\) \\6\\.kill\\("SIGKILL"\\);\\s*` +
      `\\}, 5e3, \\2\\)\\.unref\\(\\), \\3\\(\\);\\s*` +
      `\\}, (${JS_IDENTIFIER}), \\1, (${JS_IDENTIFIER})\\)\\.unref\\(\\), \\1\\.once\\("exit", (\\(\\) => (?:\\{[^{}]*\\}|[^;{}]+))\\);`,
      'g',
    ),
    replacement:
      'if ($1 && !$1.killed && $1.exitCode === null) {' +
      '\n      const processKillTimer = setTimeout(($2, $3) => {' +
      '\n        if ($2.exitCode !== null) {' +
      '\n          $3();' +
      '\n          return;' +
      '\n        }' +
      '\n        if (process.platform === "win32") {' +
      '\n          const windowsForceKillTimer = setTimeout(($4, $5) => {' +
      '\n            if ($4.exitCode === null) $4.kill("SIGKILL");' +
      '\n            $5();' +
      '\n          }, 5e3, $2, $3);' +
      '\n          windowsForceKillTimer.unref?.();' +
      '\n          return;' +
      '\n        }' +
      '\n        $2.kill("SIGTERM");' +
      '\n        const forceKillTimer = setTimeout(($6) => {' +
      '\n          if ($6.exitCode === null) $6.kill("SIGKILL");' +
      '\n        }, 5e3, $2);' +
      '\n        forceKillTimer.unref?.();' +
      '\n        $3();' +
      '\n      }, $7, $1, $8);' +
      '\n      processKillTimer.unref?.();' +
      '\n      $1.once("exit", $9);' +
      '\n    }',
  },
  {
    name: 'claude-sdk-process-transport-close',
    pattern: new RegExp(
      `if \\((${JS_IDENTIFIER}) && !\\1\\.killed && \\1\\.exitCode === null\\) setTimeout\\(\\((${JS_IDENTIFIER})\\) => \\{\\s*` +
      `if \\(\\2\\.killed \\|\\| \\2\\.exitCode !== null\\) return;\\s*` +
      `\\2\\.kill\\("SIGTERM"\\), setTimeout\\(\\((${JS_IDENTIFIER})\\) => \\{\\s*` +
      `if \\(\\3\\.exitCode === null\\) \\3\\.kill\\("SIGKILL"\\);\\s*` +
      `\\}, 5e3, \\2\\)\\.unref\\(\\);\\s*` +
      `\\}, (${JS_IDENTIFIER}), \\1\\)\\.unref\\(\\), \\1\\.once\\("exit", (\\(\\) => (?:\\{[^{}]*\\}|[^;{}]+))\\);`,
      'g',
    ),
    replacement:
      'if ($1 && !$1.killed && $1.exitCode === null) {' +
      '\n      const processKillTimer = setTimeout(($2) => {' +
      '\n        if ($2.killed || $2.exitCode !== null) return;' +
      '\n        $2.kill("SIGTERM");' +
      '\n        const forceKillTimer = setTimeout(($3) => {' +
      '\n          if ($3.exitCode === null) $3.kill("SIGKILL");' +
      '\n        }, 5e3, $2);' +
      '\n        forceKillTimer.unref?.();' +
      '\n      }, $4, $1);' +
      '\n      processKillTimer.unref?.();' +
      '\n      $1.once("exit", $5);' +
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
