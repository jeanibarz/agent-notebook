import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Golden test for issue #478: the set of runtime names the package root
// (`import * from 'agent-notebook'`) publishes. Moving code between modules
// must not add or drop a published name. Widening the root is a semver
// decision, not a side effect of a refactor.
//
// The entry is resolved from package.json `exports["."].default` rather than
// a hard-coded file, so this test passes unchanged whichever module the
// package root points at. It reads the BUILT dist/ (the global setup rebuilds
// dist/ when it is older than src/).
//
// Changing the published API on purpose? Update this list in the same PR and
// say so in the CHANGELOG. Exported TYPES are pinned at compile time in
// src/module-boundaries.test.ts.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const PUBLISHED_VALUES = [
  'ADD_BURST_N',
  'COVERAGE_HI',
  'DEFAULT_COVERAGE_HI',
  'DEFAULT_RECALL_MISS_HI',
  'DESC_KEY',
  'ERROR_CLASSES',
  'ERR_MIN',
  'ERR_RATE',
  'INVALID_NAME_CODE',
  'LOCK_GRACE_MS',
  'LOOP_N',
  'LOOP_WINDOW_S',
  'MAX_CHARS',
  'MAX_LINES',
  'NEAR_DUP',
  'NbError',
  'REASON_ENUMS',
  'RECALL_MISS_HI',
  'SILENT_H',
  'STALE_LOCK_MS',
  'STATS_SCHEMA_VERSION',
  'USAGE_RING',
  'activityByDay',
  'addBurstN',
  'addEntry',
  'asciiMode',
  'assertSafeRole',
  'assertSafeShelf',
  'classifyError',
  'coverageHi',
  'dedupKey',
  'diagnoseEngagement',
  'drainPendingRecovery',
  'entryId',
  'errMin',
  'errRate',
  'escapeDiskName',
  'expandHomeDir',
  'formatEvictedUsage',
  'getDescription',
  'getMetaValue',
  'isConflictMarker',
  'isLeftoverTemp',
  'isMetaLine',
  'isValidShelfName',
  'isValidWindow',
  'listNotebooks',
  'listRoles',
  'listShelves',
  'lockGraceMs',
  'logUsage',
  'loopN',
  'loopWindowSec',
  'maxChars',
  'maxLines',
  'merge',
  'move',
  'nearThreshold',
  'normalizeReason',
  'noteRecovery',
  'notebookExists',
  'notebooksDir',
  'overlappingShelves',
  'parseUsage',
  'parseWindowMs',
  'readEntries',
  'readMetaLines',
  'readShelf',
  'reapLeftoverTemps',
  'recallMissHi',
  'releaseHeldLock',
  'remove',
  'render',
  'renderEntries',
  'resolveIntEnv',
  'resolveIntTunable',
  'resolveRateEnv',
  'resolveRateTunable',
  'sanitizeLesson',
  'search',
  'setDescription',
  'setMetaValue',
  'showJson',
  'showJsonMany',
  'silentHours',
  'similarity',
  'sparkGlyphs',
  'sparkline',
  'split',
  'staleCandidates',
  'staleLockMs',
  'stats',
  'stealStale',
  'stripControlChars',
  'usageFile',
  'usageRing',
  'usageRingSlack',
  'vote',
  'voteMany',
  'withLock',
];

describe('package root exports (issue #478)', () => {
  test('publishes exactly the golden set of runtime names', async () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
      exports: { '.': { default: string } };
    };
    const entry = join(root, pkg.exports['.'].default);
    const mod = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
    expect(Object.keys(mod).sort()).toEqual([...PUBLISHED_VALUES].sort());
  });
});
