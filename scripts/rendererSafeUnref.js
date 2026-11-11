const TIMER_CALL_PREFIXES = ['setTimeout(', 'setInterval('];

// Electron's renderer returns numeric timer ids without .unref(); optional calls keep Node behavior.
function patchRendererUnsafeUnrefSites(contents) {
  const sites = findUnsafeTimerUnrefRanges(contents);
  let nextContents = contents;
  for (const site of sites.sort((left, right) => right.unrefStartIndex - left.unrefStartIndex)) {
    nextContents = `${nextContents.slice(0, site.unrefStartIndex)}.unref?.()${nextContents.slice(site.unrefEndIndex)}`;
  }

  return {
    contents: nextContents,
    guardedCount: sites.length,
  };
}

function findUnsafeTimerUnrefSites(contents) {
  return findUnsafeTimerUnrefRanges(contents).map(({ line, snippet }) => ({ line, snippet }));
}

function findUnsafeTimerUnrefRanges(contents) {
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
      const unrefStartIndex = callEnd + 1 + unrefMatch[0].indexOf('.');
      const line = contents.slice(0, startIndex).split('\n').length;
      matches.push({
        line,
        snippet: contents.slice(startIndex, endIndex),
        unrefStartIndex,
        unrefEndIndex: unrefStartIndex + '.unref()'.length,
      });
    }

    searchIndex = timerStart.startIndex + timerStart.prefix.length;
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
