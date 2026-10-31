# RFC 0107 — nb-janitor: shelf co-access report

- Issue: [#107](https://github.com/jeanibarz/agent-notebook/issues/107)
- Status: accepted (autonomous — additive, medium, high-confidence per the issue's own classification)
- Epic: self-observing notebook (#73)

## Problem

A **shelf** is defined — in `docs/requirements.md` and the README — as lessons
grouped by *co-access*: the lessons an agent needs *in the same situations*. Yet
nothing in the toolchain measures actual co-access. The offline janitor
(`examples/nb-janitor.mjs`) already reports near-duplicate shelf *names*
(section 2) and duplicate *lessons* (section 3), but it never reports which
shelves are *shown together* in the same session — the one signal that would
tell you two differently-named shelves are really one ("always opened
together → consider merging/namespacing") or that a shelf is isolated ("never
opened alongside another"). `docs/requirements.md` (FR-USAGE-002) even notes
co-access "is then not computed" when `NB_SESSION` is blank. The data is already
in hand: `readUsage()` parses the `session` and `command` columns.

## Design

A new **section 5** in the read-only offline janitor. No change to the hot `nb`
path (DP-6), no notebook-file schema change (NG-004), no new usage-log column,
zero dependencies. It is a pure read of the usage ring the janitor already
loads.

### What counts as a co-access

- Group usage rows by `session`.
- Within a session, collect the **set of distinct shelves that had a `show`**
  (the surfacing action the shelf definition is about). `show` only — not
  `search`/`vote`/`add` — because the question is which shelves got *surfaced
  together*.
- Rows with a **blank session are excluded** (FR-USAGE-002: co-access is not
  computed without `NB_SESSION`). A session contributes to co-access only if it
  shows **≥ 2 distinct shelves**; a lone-shelf session establishes that the
  shelf was shown (so it can be judged *isolated*) but creates no pair.

### Metrics

For each shelf, `shows` = number of distinct non-blank sessions it was shown in.
For each unordered pair `(a, b)`, `co` = number of sessions that showed both.

The co-access **ratio** of a pair is `co / min(shows(a), shows(b))` — "when the
*rarer* of the two is surfaced, how often is the other surfaced too". A ratio
near 1 means the rarer shelf is almost never opened without the other: the
merge/namespace signal. Using `min` (not union/Jaccard) is deliberate — it
catches the asymmetric case where a small shelf's contexts are a **subset** of a
larger one's (`shows(a)=2, shows(b)=20, co=2 → 1.0`), which is exactly the
"fold the little one in" case; Jaccard (`2/20 = 0.1`) would hide it.

### Thresholds (keep a small store quiet — the issue's stated risk)

Hardcoded constants, in the style of section 1's `LOSS_MIN` and section 2's
`0.8` name-similarity cutoff (no new flag):

- `COACCESS_MIN_SUPPORT = 2` — a pair needs `co ≥ 2` co-sessions to report. One
  shared session is coincidence, not a pattern.
- `COACCESS_MIN_RATIO = 0.8` — a pair reports as **high co-access** when
  `co ≥ MIN_SUPPORT` **and** `ratio ≥ 0.8`.
- **Isolated**: a shelf that was shown in ≥ 1 non-blank session but whose `co`
  with *every* other shelf is 0 — never once surfaced alongside another shelf.
  Only reported when **≥ 2 distinct shelves were shown overall** (with one shelf
  ever shown, "isolated" is trivially true and meaningless).

Both lists are sorted (pairs by ratio then `co` desc; isolated by `shows` desc)
and capped at 25 rows like section 3, with a `…(N more)` note.

### Degradation (acceptance criterion)

If **no non-blank session shows anything** (every show row has a blank session,
or there are no show rows), the section degrades to a **one-line note**, not an
error — mirroring how section 4 degrades without git:

```
  (no sessions with NB_SESSION set — co-access not computed; set NB_SESSION so
   shelves shown together can be correlated)
```

### JSON

`report.coAccess` is added, always present:

```jsonc
{
  "computed": true,            // false ⇒ degraded; the two lists are then empty
  "sessions": 7,               // # non-blank sessions that showed ≥1 shelf
  "highPairs": [
    { "a": "patcher", "b": "repo-cartographer", "co": 4, "support": 4, "ratio": 1 }
  ],
  "isolated": [
    { "shelf": "changelog", "shows": 3 }
  ]
}
```

## Alternatives considered

- **Jaccard over the session sets** instead of `min`-denominated confidence —
  rejected: it misses the asymmetric subset case that is the primary merge
  signal (above).
- **Counting any command, not just `show`** — rejected: the shelf definition is
  about what gets *surfaced together*; a `vote`/`add` touches one shelf the
  agent already had in hand and is not a co-surfacing event.
- **A tunable `--coaccess <ratio>` flag** — deferred (YAGNI): sections 1/2
  hardcode their cutoffs; a flag can be added if a real store proves 0.8 wrong.

## Testing

End-to-end against the real script (`node examples/nb-janitor.mjs`) over a
seeded temp `NB_DIR`: a store with known co-open sessions yields the expected
pair counts and ratio, the isolated shelf is named, the blank-session store
degrades to the one-line note (exit 0, no error), and `--json` carries
`coAccess`. A mutation pass flips each new constant/branch and requires a test
to fail.
