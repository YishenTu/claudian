import { createVitest } from 'vitest/node';

// The CLI exposes related execution and file listing separately. Use the same
// public selection API as `vitest list`, with the runtime-related source filter.
const vitest = await createVitest({ watch: false, related: process.argv.slice(2) });
try {
  const specifications = await vitest.getRelevantTestSpecifications();
  console.log(JSON.stringify([...new Set(specifications.map(spec => spec.moduleId))]));
} finally {
  await vitest.close();
}
