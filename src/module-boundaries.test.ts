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
const INTERNAL = ['preserveMode', 'skipUnreadable', 'readNbJson', 'setCallMaxChars', 'resolveIntTunableStatus', 'setCallNoCreateDir', 'setCallLockCheck']; // readNbJson..resolveIntTunableStatus: RFC 0530's call-scoped .nb.json override; setCallNoCreateDir: issue #548

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

  // Issue #493 moved the CLI's non-dispatch code out of cli.ts. Each helper
  // module sits below the dispatcher: cli.ts imports them, never the reverse.
  test('the CLI helper modules sit below cli.ts, and nothing in src imports cli (issue #493)', () => {
    const graph = importGraph();
    expect(graph.get('cli')).toEqual(expect.arrayContaining(['suggest', 'config-report', 'render', 'enabled']));
    expect(graph.get('suggest')).toEqual([]);
    expect(graph.get('enabled')).toEqual(['git']);
    expect(graph.get('config-report')?.slice().sort()).toEqual(['enabled', 'messages', 'notebook', 'stats', 'suggest']);
    expect(graph.get('render')?.slice().sort()).toEqual(['notebook', 'stats']);
    for (const [mod, deps] of graph) {
      expect(deps, `${mod}.ts imports the CLI entry point`).not.toContain('cli');
    }
  });

  // Issue #538: the agent-facing loop (`nb brief`, `nb retro`) and its text sit below cli.ts.
  // The mechanism never learns about them, and only the CLI reaches them.
  test('the agent-facing loop modules sit below cli.ts and the mechanism never imports them (issue #538)', () => {
    const graph = importGraph();
    expect(graph.get('agent-text')).toEqual([]);
    expect(graph.get('loop')?.slice().sort()).toEqual(['agent-text', 'enabled', 'messages', 'notebook', 'project', 'render']);
    expect(graph.get('cli')).toEqual(expect.arrayContaining(['loop']));
    expect(graph.get('notebook')).toEqual([]);
    for (const [mod, deps] of graph) {
      if (mod !== 'cli') expect(deps, `${mod}.ts imports loop`).not.toContain('loop');
      if (mod !== 'loop') expect(deps, `${mod}.ts imports agent-text`).not.toContain('agent-text');
    }
  });

  // Issue #540: one module starts processes, and the project name sits below it.
  test('only git.ts starts a process, and the project name depends on nothing but it (issue #540)', () => {
    const graph = importGraph();
    expect(graph.get('git')).toEqual([]);
    expect(graph.get('project')).toEqual(['git']);
    for (const f of readdirSync(srcDir)) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts') || f === 'git.ts') continue;
      const text = readFileSync(join(srcDir, f), 'utf-8');
      expect(/from 'node:child_process'/.test(text), `${f} imports node:child_process`).toBe(false);
    }
  });

  // Issue #548: where a call's lessons live is decided by one module, on top of the
  // project name and the mechanism; only the CLI reaches it, and the mechanism never does.
  test('the place resolver sits on the project name and the mechanism, below cli.ts (issue #548)', () => {
    const graph = importGraph();
    expect(graph.get('place')?.slice().sort()).toEqual(['notebook', 'project']);
    expect(graph.get('place-ops')).toEqual(['notebook']);
    expect(graph.get('cli')).toEqual(expect.arrayContaining(['place-ops']));
    expect(graph.get('cli')).toEqual(expect.arrayContaining(['place']));
    for (const [mod, deps] of graph) {
      if (mod !== 'cli') expect(deps, `${mod}.ts imports place`).not.toContain('place');
    }
  });

  // Issue #539: the user's message files. The module reads a folder and takes plain values (the home
  // folder, a project name): it never runs git, never writes, and knows no project or place module,
  // so the rules about who selects a file stay in the commands that call it.
  test('the message-file module imports only the standard library and the mechanism, and only loop and config-report import it (issue #539)', () => {
    const graph = importGraph();
    expect(graph.get('messages')).toEqual(['notebook']);
    const text = readFileSync(join(srcDir, 'messages.ts'), 'utf-8');
    const external = [...text.matchAll(/^import\b[^;]*?\bfrom '([^']+)'/gm)].map((m) => m[1]).filter((m) => !m!.startsWith('./'));
    expect(new Set(external)).toEqual(new Set(['node:fs', 'node:path']));
    expect(/from 'node:child_process'|\bimport\(/.test(text)).toBe(false);
    expect(/\b(writeFileSync|appendFileSync|mkdirSync|renameSync|unlinkSync|rmSync|copyFileSync|openSync\([^)]*['"]w)/.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''))).toBe(false);
    for (const [mod, deps] of graph) {
      if (mod !== 'loop' && mod !== 'config-report') expect(deps, `${mod}.ts imports messages`).not.toContain('messages');
    }
    expect(graph.get('cli')).not.toContain('messages');
  });

  test('no source module speaks a harness hook format (issue #538)', () => {
    // The core stays harness-blind: the Claude Code reply and payload fields live
    // in the adapter under examples/, never in src/.
    for (const f of readdirSync(srcDir)) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
      const text = readFileSync(join(srcDir, f), 'utf-8');
      for (const term of ['hookSpecificOutput', 'stop_hook_active', 'additionalContext', 'hook_event_name', 'background_tasks']) {
        expect(text.includes(term), `${f} mentions ${term}`).toBe(false);
      }
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
