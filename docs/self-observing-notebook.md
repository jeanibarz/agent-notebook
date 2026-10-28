# The Self-Observing Notebook — design rationale

This document explains *why* `agent-notebook` instruments itself, what each
operation signals, and — the part most easily muddled — how we tell the
different quality dimensions apart: **engagement**, **coverage**, **recall**,
**precision**, and **serendipity**. It is the companion to the behavioural
spec in [`requirements.md`](./requirements.md); where that file says *what the
tool does*, this one says *why the signals are shaped the way they are and how
to read them*.

It is design rationale, not an API reference. Terms are defined on first use.

---

## 1. Why self-observe at all

The product's load-bearing principle is
[DP-8](./requirements.md#dp-8): **a notebook's job is to surface the lesson an
agent would not think to search for.** If the agent already knew to look for a
lesson, it would scarcely need the memory — so the value concentrates exactly
where ordinary search is useless.

That makes the tool hard to evaluate by asking "did the agent find what it
searched for?" — the interesting lessons are the *un-searched-for* ones. We
need a way to tell, from real use, whether the notebook is delivering them.

The insight that makes this cheap: **an agent cannot know what will help before
a task, but it knows exactly what helped afterwards — and it already records
that.** At the end of a task it votes on the lessons it used and tries to add
anything new it learned. That end-of-task behaviour is a free, honest answer
key. We do not stage a test; we read the trail real work leaves behind.

---

## 2. The architecture: a dumb core, a rich log, offline janitors

Two principles keep the observability rich without betraying the tool's
minimalism (no embeddings, no server, no schema — see
[NG-001](./requirements.md#ng-001), [NG-003](./requirements.md#ng-003),
[NG-004](./requirements.md#ng-004)):

- **Every action is dual-purpose.** A good action is one the agent performs for
  its own sake, that *also* leaks a signal. This is the test for any new
  operation: *would the agent do it even if nobody were measuring?* An action
  that exists only to feed metrics is busywork the agent will skip or fake.
- **The signal lives in the log, not the notebook.** The notebook file stays
  one dumb line per lesson. The *usage log* (`.nb-usage.log`) carries the rich,
  structured record — operation, outcome, entry id, session, optional reason.
  This is what lets observability grow without adding a field to a lesson.

The resulting shape:

> The runtime stays dumb, deterministic, and offline — one line per lesson, a
> millisecond per call. The usage log is a self-labelling signal stream. All
> intelligence — threshold tuners, description rewriters, a re-organiser,
> eventually a tiny learned matcher — lives in **offline janitors** that read
> the log and rewrite the plain files. Nothing clever ever runs inside an `nb`
> call (preserving [DP-6](./requirements.md#dp-6)).

---

## 3. The signal catalogue

Each operation answers a different question. Reasons (`--reason <code>` with an
optional `--note`, logged never stored, always optional) disambiguate intent
where the surface form is ambiguous.

| Operation | What it signals | Reads onto |
|---|---|---|
| **add — accepted** | the notebook was *missing* this; a new lesson entered | coverage |
| **add — dedup-blocked** | the agent re-derived something the notebook *already held* | surfacing **recall** miss |
| **upvote (+1)** | "I used this." If it arrived unbidden: a confirmed serendipity hit; reused across many tasks: a load-bearing lesson | serendipity, value |
| **downvote (−1)** | "surfaced but unhelpful/wrong." On a *pushed* lesson: noise we delivered | surfacing **precision** miss, content quality |
| **merge** (`reason=duplicate`) | a *reworded* duplicate had accumulated that the literal dedup check let through | recall (paraphrase misses) |
| **split** (`reason=overloaded`) | an entry was too coarse — two lessons in one line | entry granularity / cap strain |
| **rm** (`reason=wrong`/`obsolete`) | bad content (fix the add-guidance) vs natural rot (expected) | content quality vs rot |
| **show without a following vote** | a notebook was opened and nothing in it used — its description over-promised | surfacing precision (shelf level) |

Why reasons matter: an agent may `merge` not because two entries duplicate but
because editing one and deleting the other is cheaper than three calls. Without
a reason, "merge = a reworded duplicate" is confounded by these
merges-of-convenience; with `reason=duplicate` we filter to the merges that
actually mean it. Reasons are also *typed labels* for the self-improvement
layer (§5). The reason vocabulary is **seed-and-grow**: a tiny per-operation
enum for the distinction we already need, plus `other`, plus optional free
text; a rising `other` rate is the signal to mine the free text and grow the
enum — we never predefine a speculative taxonomy.

---

## 4. Discriminating the quality dimensions

This is the crux: several dimensions are easy to conflate. Each has a distinct
question, a distinct signal, and a distinct remedy.

| Dimension | Question | Signal (from the log) | Distinguished by |
|---|---|---|---|
| **Engagement** (liveness) | Is the agent actually using the notebook — tool works *and* agent instructed? | presence of **votes** (and ops) in a session | It is the *gate under everything*. A session with no ops is a setup/plumbing problem, not a surfacing result — exclude it from scoring rather than read it as "healthy quiet." A steady stream of **votes with few adds** is a genuine "notebook is sufficient" signal. |
| **Coverage** | Is needed knowledge *missing* from the notebook? | **novel-add rate** = accepted adds ÷ add attempts | High early (an empty notebook being filled) — expected, not a fault. Orthogonal to surfacing: coverage is about what *exists*. |
| **Surfacing — recall** | Did a relevant lesson that *exists* fail to reach the agent? | **dedup-block rate** = blocked adds ÷ add attempts; plus `merge{duplicate}` for paraphrase re-derivations | The agent **re-derived something already stored**. Robust to task novelty (a dup is a dup, new task or old) and to agent laziness (a disengaged agent isn't in the denominator). |
| **Surfacing — precision** | Was what the notebook *pushed* actually wanted? | **downvote rate on pushed, not-searched lessons** | The agent was shown it unbidden and judged it unhelpful. This is the counterweight to "surface everything": chasing recall alone drives precision down. |
| **Serendipity** | Did we surface a relevant lesson the agent *wouldn't have searched for*? | **upvote on a lesson delivered by push** (injection/organization), not via a targeted search | **relevant ∧ arrived-unbidden.** This is the positive goal of DP-8; recall and precision are its two failure modes. |

### The one reading that resolves "few adds is ambiguous"

Coverage and recall read as a 2×2 (engagement gates the whole grid):

|                    | **dedup-blocks LOW** | **dedup-blocks HIGH** |
|--------------------|----------------------|-----------------------|
| **novel-adds LOW** | ✅ Healthy — covers *and* surfaces | 🚨 Surfacing failure — content present, not reaching the agent |
| **novel-adds HIGH**| 🌱 Coverage-building — young notebook filling gaps | ⚠️ Churny — gaps *and* poor surfacing |

"The agent barely adds anything" is only ambiguous *alone*. Beside the
dedup-block rate it resolves: low-low is the win; low-high is the alarm.

### Recall and precision are a pair

A notebook can "win" on recall by shoving everything at the agent — so the
headline recall-miss rate is always read next to the precision-miss rate. A
healthy notebook keeps **both** low. The dedup-block rate stays the primary
alarm (re-learning what you already know is the clearest failure), but it is
one half of a pair.

---

## 5. How the signals get used — a gated ladder

The signals drive three escalating uses. You climb only as far as the measured
signal forces you.

1. **Diagnose.** The free signals `nb stats` surfaces today —
   browse-without-use, eviction-while-still-voted, vote-reversal — plus the
   rate-by-reason breakdowns, point at *which* description, cap, or entry needs
   attention. Read-only; a human (or a future re-organiser) acts.
2. **Self-calibrate — without a model.** The tool labels its own data: every
   `merge{duplicate}` is a positive duplicate pair; every `rm`/downvote with a
   reason is a content-quality label. The first rung of "better dedup" is a
   **learned threshold**, not a model: fit the single lexical-similarity cutoff
   (token overlap, shared rare words, edit distance) to the merge labels. It is
   deterministic, offline, and barely dents "no embeddings."
3. **Self-improve — gated, and only if needed.** A tiny linear classifier over
   the same cheap features, then (only if the *measured* paraphrase-miss rate
   proves it necessary) a small embedding model. Guardrails are non-negotiable:
   - **Determinism ([DP-6](./requirements.md#dp-6)):** any learned part is a
     *versioned, pinned file* trained by an offline janitor, never mutating
     inside the hot `add` path.
   - **Never silently mislead ([DP-5](./requirements.md#dp-5)):** a fuzzy match
     that silently rejects a genuinely new lesson is a silent loss, so near the
     threshold it must *soft-suggest* ("looks like X — add anyway, or merge?"),
     hard-blocking only on near-certainty.
   - **Local, fast, fail-open:** loads in milliseconds, works if absent (falls
     back to exact dedup), never a network call.

What we deliberately do **not** do: force the agent to write a quota of
lessons. The honesty of "no add" *is* the measurement — a quota Goodharts the
signal, pollutes the bounded notebook, and manufactures false recall misses.

### Two honest limits

- The dedup-block signal is a **lower bound** on recall misses: it catches
  near-verbatim re-derivations; paraphrased ones slip through (though `merge`
  recovers some after the fact).
- Live signals see hits and re-derivations, not *pure silence* — a relevant
  lesson that is never surfaced *and* never re-derived leaves no trace. A small
  periodic audit covers that residual.

---

## 6. Status

What is implemented today (merged):

- Entry-level + outcome logging in the usage ring (dedup-block with its
  collision target, eviction events, entry ids, session) — issue #67.
- `nb split`, the reverse of merge — #68.
- Optional per-operation reasons (`--reason`/`--note`, seed-and-grow enum) — #69.
- Notebook descriptions (`# key: value` metadata) and `nb describe` — #70.
- `nb list` discovery — #71.
- The free diagnostic signals in `nb stats` (browse-without-use,
  eviction-while-still-voted, vote-reversal) — #72.
- The named **recall-miss / precision-miss rates** and the coverage×surfacing
  readout in `nb stats`, with the vote-liveness engagement gate — #81.
- `nb search` — the demoted keyword fallback and `failed-search → add`
  gap-sensor, explicitly secondary to surfacing per
  [NG-007](./requirements.md#ng-007). A `no-match` search is logged (query in the
  usage note) so a subsequent `add` in the same session reads back as a
  `failed-search` coverage-gap signal — the signal deferred from #72 — #82.

Planned (Phase 2 of the umbrella):

- The session-start injection contract (inject the index alongside the agent's
  own notebook) — lives in the runtime hook, not this package.
- Grouping by a `.` namespace convention.

Gated (Phase 3 — build only when the measured paraphrase-miss rate demands it):

- The learned-threshold dedup of §5, and anything above it.
