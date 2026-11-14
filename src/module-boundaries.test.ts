import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as root from './index.js';
import * as notebook from './notebook.js';
import * as usage from './usage.js';
import * as stats from './stats.js';
// Compile-time pin of the 38 TYPE names the package root published before
// issue #478 split notebook.ts. Object.keys cannot see types, so the golden
// test in package-exports.test.ts covers only runtime names; dropping a type
// from src/index.ts fails `npm run typecheck` here instead.
import type {
  AddResult,
  Anomaly,
  CommandStat,
  ConflictShelf,
  DescribeResult,
  DiagnosticSignal,
  EngagementDiagnosis,
  Entry,
  ErrorCause,
  ErrorClass,
  IntTunable,
  ListOptions,
  MergeResult,
  MoveResult,
  NotebookListing,
  NotebookStat,
  NotebookSummary,
  NotebookTotals,
  RateTunable,
  ResolvedInt,
  SearchGroup,
  SearchHit,
  SearchOptions,
  SearchResult,
  ShelfContents,
  ShowEntry,
  ShowResult,
  SkippedShelf,
  SplitResult,
  StaleEntry,
  StaleResult,
  StatsReport,
  SurfacingMetrics,
  TunableStatus,
  UsageMeta,
  UsageRow,
  VoteManyItem,
  VoteResult,
} from './index.js';

// Guards the module layout of issue #478: notebook.ts is the mechanism,
// usage.ts and stats.ts are the self-monitoring layer on top of it, and
// index.ts is the package root that re-exports all three.
const srcDir = dirname(fileURLToPath(import.meta.url));

/** Relative imports of each non-test src/*.ts file, as module basenames (`./usage.js` -> `usage`). */
function importGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const f of readdirSync(srcDir)) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts') || f.endsWith('.d.ts')) continue;
    const text = readFileSync(join(srcDir, f), 'utf-8');
    // Static `import … from` / `export … from`, bare side-effect `import './x.js'`,
    // and dynamic `import('./x.js')`: any of them makes x a load-time dependency.
    const deps = [
      ...text.matchAll(/^(?:import|export)\b[^;]*?\bfrom '\.\/([\w-]+)\.js'/gm),
      ...text.matchAll(/^import '\.\/([\w-]+)\.js'/gm),
      ...text.matchAll(/\bimport\(\s*'\.\/([\w-]+)\.js'\s*\)/g),
    ].map((m) => m[1]);
    graph.set(f.replace(/\.ts$/, ''), [...new Set(deps)]);
  }
  return graph;
}

/** Internals exported by a module for the other src modules, deliberately NOT on the package root. */
const INTERNAL = ['preserveMode', 'skipUnreadable'];

describe('module boundaries (issue #478)', () => {
  test('src/*.ts has no import cycle', () => {
    const graph = importGraph();
    // Sanity: the parser sees the edges this layout relies on.
    expect(graph.get('stats')).toEqual(expect.arrayContaining(['notebook', 'usage']));
    expect(graph.get('index')).toEqual(expect.arrayContaining(['notebook', 'usage', 'stats']));
    const state = new Map<string, 'visiting' | 'done'>();
    const cycles: string[] = [];
    const visit = (n: string, path: string[]): void => {
      if (state.get(n) === 'done') return;
      if (state.get(n) === 'visiting') {
        cycles.push([...path.slice(path.indexOf(n)), n].join(' -> '));
        return;
      }
      state.set(n, 'visiting');
      for (const d of graph.get(n) ?? []) visit(d, [...path, n]);
      state.set(n, 'done');
    };
    for (const n of graph.keys()) visit(n, []);
    expect(cycles).toEqual([]);
  });

  test('the mechanism does not depend on the monitoring layer, and nothing in src imports the root', () => {
    const graph = importGraph();
    expect(graph.has('notebook')).toBe(true);
    expect(graph.get('notebook')).toEqual([]);
    expect(graph.get('usage')).toEqual(['notebook']);
    for (const [mod, deps] of graph) {
      if (mod !== 'index') expect(deps, `${mod}.ts imports the package root`).not.toContain('index');
    }
  });

  test('the root re-exports every module export except the named internals', () => {
    // index.ts lists notebook.ts names explicitly (so the internals stay off the
    // root). This catches the other direction: a new public export in a module
    // that was never added to the root, or an internal that reached it.
    const all = new Set([...Object.keys(notebook), ...Object.keys(usage), ...Object.keys(stats)]);
    for (const n of INTERNAL) expect(all.has(n), `${n} is no longer exported; drop it from INTERNAL`).toBe(true);
    const expected = [...all].filter((n) => !INTERNAL.includes(n)).sort();
    expect(Object.keys(root).sort()).toEqual(expected);
  });
});
