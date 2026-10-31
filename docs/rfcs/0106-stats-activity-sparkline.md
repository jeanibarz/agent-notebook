# RFC 0106 — `nb stats`: ops-per-day activity sparkline

- Issue: [#106](https://github.com/jeanibarz/agent-notebook/issues/106)
- Status: accepted (autonomous — small, additive, high-confidence per the issue's own classification)
- Epic: self-observing notebook (#73)

## Problem

`nb stats` shows a per-command table and each command's `last-used` timestamp,
but nothing about activity *over time*. "When did this store go quiet?" — a core
observability question — currently needs eyeballing raw `.nb-usage.log`
timestamps. There is no at-a-glance view that a store was busy last week and has
been silent for three days.

## Design

A **read** of the usage ring — no notebook-file schema change ([NG-004]), no new
agent action, no new usage-log column. Computed in `stats()` from the same
windowed, scoped `recent` rows that already feed the per-command table, and
surfaced both in the human table (one line) and in `--json`.

### The sparkline helper

A pure, exported helper:

```ts
sparkline(counts: number[]): string
```

mapping each count to one of the eight Unicode block glyphs
`▁▂▃▄▅▆▇█` (indices 0–7). Zero dependencies — no chart library, no network — in
keeping with the tool's zero-dep design.

**Scaling is zero-based, not min–max** (the one real semantics choice):

```
max = Math.max(...counts)
glyph(c) = max <= 0 ? ▁ : GLYPHS[clamp(round(c / max * 7), 0, 7)]
```

- `sparkline([])` → `''`.
- All-zero (or max ≤ 0) → every bucket renders the floor glyph `▁`.
- Otherwise each bar is proportional to the window's **busiest** bucket.

Rationale for zero-based over the issue's suggested min–max: for a *count* plot
the whole point is "went quiet", so a **silent (0-op) bucket must read as the
floor** `▁`, and a busy bucket as `█`. Min–max scaling would stretch a nearly
flat series — e.g. `[5, 6, 7]` — into a dramatic `▁▄█` ramp and, worse, would
make a 0-op bucket indistinguishable from the window's minimum whenever that
minimum is itself nonzero. Zero-based scaling keeps the floor meaningful. The
exact, testable identity it yields: `sparkline([0,1,2,3,4,5,6,7])` →
`▁▂▃▄▅▆▇█`.

### Bucketing: rolling 24-hour buckets anchored at `now`

Usage rows are bucketed into **rolling 24-hour windows counting back from
`now`**, not calendar days:

- Bucket count = `max(1, ceil(windowMs / 86_400_000))`. A `7d` window → 7
  buckets; `12h` → 1; `36h` → 2; `10d` → 10.
- A row of age `a = now − ts` lands in bucket-from-the-right `floor(max(0,a) / DAY)`,
  clamped to the oldest bucket. The array is returned **oldest-first** (leftmost
  glyph = oldest 24h, rightmost = most recent 24h).

Rationale for rolling-24h over calendar-day bucketing: it is **timezone-free**
(no local-vs-UTC question — the only input is `now` and each row's epoch ms) and
**deterministic given `now`**, which also makes it trivially unit-testable with a
fixed `now`. The sum of the buckets equals the window's scoped call count
(`totalCalls`), so the rendered `(7d, N ops)` label is exactly that total.

Scope follows the rest of the report: `nb stats <shelf>` buckets only that
shelf's rows; the unscoped report buckets all rows.

### Rendering

One line, printed right under the `nb usage — …` header:

```
  activity  ▂▁▅█▇▃▁  (7d, 41 ops)
```

`(7d` is `rep.window`; `41 ops` is `rep.totalCalls`. An empty or single-day
window renders without crashing (`▁▁▁▁▁▁▁  (7d, 0 ops)` / `█  (12h, 3 ops)`).

### `--json`

`StatsReport` gains one additive field:

```ts
/** Ops per rolling-24h bucket over the window, oldest bucket first. */
activity: number[];
```

Every existing field is unchanged. `activity.length` is the bucket count and
`sum(activity) === totalCalls`.

## Scope / non-goals

- No plain-ASCII fallback flag. The issue defers it ("add a plain fallback only
  if a user reports rendering issues"); the eight block glyphs render in all
  modern terminals.
- No per-command or per-shelf breakdown of the sparkline — one line for the
  whole scoped window, as the issue specifies.
- No new tunable env var; the bucket granularity derives from the existing
  `--since` window.

## Acceptance criteria (from the issue)

- `sparkline([…])` maps known counts to a known glyph string — unit-tested,
  including the `▁▂▃▄▅▆▇█` identity, `[]`, and all-zero.
- `nb stats` prints one activity line bucketed by day over the window.
- Empty and single-day windows render without crashing.
- `nb stats --json` includes the per-day counts (`activity`). No new runtime
  dependency.
