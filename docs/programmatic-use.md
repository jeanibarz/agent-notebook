# Programmatic use

*The `nb` CLI is a thin wrapper over a small TypeScript library. This page walks through the main calls. The package also exports error classes, the tunable getters (`maxLines`, `nearThreshold` and so on) and the usage-log and stats helpers; the full list is `src/index.ts`, and the types ship in `dist/index.d.ts`. The README's [Programmatic use](https://github.com/jeanibarz/agent-notebook/blob/main/README.md#programmatic-use) section has a shorter example.*

```sh
npm install agent-notebook
```

The package is ESM only (`"type": "module"`), needs Node.js 18+, and has no runtime dependencies. Types ship with it.

## The main calls, in one example

```ts
import {
  addEntry,
  readEntries,
  vote,
  merge,
  split,
  remove,
  move,
  setDescription,
  getDescription,
  showJson,
  stats,
  render,
  search,
  listShelves,
  listNotebooks,
  notebooksDir,
  type AddResult,
  type SearchResult,
  type MoveResult,
  type ShowResult,
  type StatsReport,
} from 'agent-notebook';

// `dir` is the storage directory. Any path works; notebooksDir() resolves the
// default — $NB_DIR if set, else ~/.agent-notebook/notebooks — the same
// location the `nb` CLI uses.
const dir = notebooksDir();

// addEntry never throws on a *content* rejection and never silently truncates:
// it resolves to an AddResult. Check `added`; when it is false, `reason` says
// why — 'duplicate' (an equivalent line already exists), 'empty' (nothing left
// after sanitizing), or 'too-long' (over NB_MAX_CHARS; `length` carries the
// submitted size so you can report it). The success case is 'added' — a newcomer
// is ALWAYS admitted, even into a full notebook (the lowest-scored line is evicted,
// the stalest survivor aged and moved to the end; see docs/eviction-and-aging.md), so `evicted` may
// name a removed entry. (An invalid shelf name or an I/O error still throws —
// those are faults, not rejected content.)
const r: AddResult = await addEntry(dir, 'build-and-test', 'run lint before claiming done');
if (!r.added) console.warn(`not stored: ${r.reason}`);
await addEntry(dir, 'build-and-test', 'run the linter first'); // a near-duplicate
await addEntry(dir, 'build-and-test', 'obsolete note to drop');

const entries = readEntries(dir, 'build-and-test'); // Entry[] = { score, text }

// vote/merge/remove select an entry by stable id, unique prefix, or unique text
// substring — and throw if the selector matches no entry, or more than one.
await vote(dir, 'build-and-test', 'run lint before', +1);

// merge folds two entries into a single line, inheriting the higher of their
// two scores; remove deletes one. Both rewrite the notebook under the same lock
// as addEntry and vote.
await merge(dir, 'build-and-test', 'run lint before', 'linter first', 'run lint before every commit');

// split is the reverse of merge: it replaces one overloaded entry with two,
// each inheriting the original's score. It throws (writing nothing) on an empty
// or over-long half, on two halves that are duplicates of each other, or on a
// half that would duplicate a surviving entry — so a split never creates a dup.
await split(dir, 'build-and-test', 'run lint before every commit', 'run lint before every commit', 'also run the type-checker before every commit');

await remove(dir, 'build-and-test', 'obsolete note');

listShelves(dir); // string[] — shelves that already have a notebook, sorted (`listRoles` is a deprecated alias)

// listNotebooks is the richest-first index behind `nb list` (name, lesson count,
// description, with a top-lesson `auto` fallback). Phantom empty notebooks are
// hidden; `total` counts every match so a caller can render "shown of total".
listNotebooks(dir, { prefix: 'review.', limit: 50 });
// → { dir, total, rows: [{ shelf, role, lessons, desc, auto }, ...], skipped: [{ shelf, code }], conflicts: [{ shelf, marker }] }
// (`role` is a deprecated copy of `shelf`, kept so existing callers keep working;
// `skipped` lists shelves whose file could not be read and `conflicts` shelves
// holding a git merge-conflict marker — both `[]` on a healthy store.)

// move relocates one entry to another shelf WITH ITS SCORE INTACT — the
// score-preserving consolidation that add+rm cannot express (add always starts a
// new entry at score +1, so earned votes are lost). Reach for it when two shelves
// turn out to be the same situation. The selector (a text fragment, here
// 'type-checker before') must match exactly one source entry, as in
// vote/merge/remove. move refuses — writing nothing to either shelf — when the
// selector is ambiguous or the target already holds an exact duplicate (the same
// normal form `add` uses to skip duplicates); then `reason` is 'duplicate' and
// nothing moves. A merely similar lesson on the target does not block a move.
const moved: MoveResult = await move(dir, 'build-and-test', 'ci-hygiene', 'type-checker before');
if (moved.reason === 'duplicate') console.warn(`already on target: ${moved.collidedId}`);

// setDescription/getDescription write and read a shelf's one-line description —
// the `# desc:` summary of when to use the shelf that `nb list` shows.
// setDescription is sanitized and length-limited like a lesson (the same cap as
// `add`) — an over-length description is rejected, not truncated — and an empty
// text clears it. getDescription returns null when none is set.
await setDescription(dir, 'build-and-test', 'what to check before claiming a task done');
const desc: string | null = getDescription(dir, 'build-and-test');

// showJson is the machine-readable sibling of render(): the shelf, its
// description, and every entry's id (a short hash of the text), score and text in
// the same highest-score order render() prints — so you recover ids without
// regex-parsing the human output.
const shown: ShowResult = showJson(dir, 'build-and-test');

// stats reads the recent-usage log (a bounded buffer of recorded calls) and rolls
// it up per command over a window (default 7 days), flagging anomalies — a
// command looping, no longer being called, or erroring often. Pass windowMs (in
// milliseconds) to set the window; pass { shelf } to scope to one shelf, or
// omit it for a deployment-wide view. getDescription, showJson and stats are
// synchronous reads (no await).
// stats counts `nb` CLI calls from the usage log; library calls are not logged,
// so in a folder no `nb` command has touched this prints 0 [].
const report: StatsReport = stats(dir, { windowMs: 24 * 60 * 60 * 1000 });
console.log(report.totalCalls, report.anomalies);

console.log(render(dir, 'build-and-test')); // highest-scored first

// search is the keyword fallback behind `nb search`: AND over the terms, across
// every notebook's lessons and descriptions, grouped by notebook.
const hits: SearchResult = search(dir, 'lint');
console.log(hits.total);
```

The CLI is a thin wrapper over this library — `src/notebook.ts` is the whole mechanism, with zero runtime dependencies. The self-monitoring layer lives beside it: `src/usage.ts` writes the usage log (one row per `nb` CLI call; library calls are not logged; a row can hold search query text and the `NB_SESSION` value) and `src/stats.ts` reads it back for `nb stats`. A review of what the package records should read all three files.
