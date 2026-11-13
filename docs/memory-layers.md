# Memory layers: project, domain and global shelves

*A naming convention for teams and harnesses that run agents across several
repositories. It uses only what `nb` already has; nothing in the tool changes.*

If one agent works in one repo, a flat list of shelves is enough. If a fleet of
agents works across many repos, three questions come up that the
[shelf and `@project` rules in AGENTS.md](../AGENTS.md#4-shelves-namespaces-and-scoping--pick-the-right-notebook)
do not answer:

- A new lesson could go in a shelf for this repo or in one that every repo shares. Which?
- Two shelves disagree. Which one does the agent trust?
- A lesson turns out to be true everywhere. How does it move up?

This page answers them with three **layers** (how widely a lesson holds) and a
few rules for moving between them. Some terms used below: a **shelf** is one
`<name>.md` notebook file of one-line lessons; a **situation** is a kind of work
a shelf is named after, such as `code-review` or `release-notes`; each lesson
carries a **score** (shown as `[+1]`) that agents raise or lower with `nb vote`;
a **slug** is a short repo identifier such as `acme-app` (an invented example); a
**harness** is the program that launches your agents; and a **SessionStart
hook** is a script the harness runs when a session starts, whose output is added
to the agent's context, typically the **index** (the list of shelf names with a
one-line description each).

> **This is a convention, not a feature.** `nb` does not know what a layer is. It
> treats `@` as an ordinary character inside a shelf name, stores nothing about a
> layer in a shelf file, and does not rank, filter or protect shelves by layer.
> Everything here is a rule you give your agents (usually in AGENTS.md or
> CLAUDE.md) and, optionally, a hook that sorts the index for them. See
> [what `nb` deliberately does not do](#what-nb-deliberately-does-not-do).

## The three layers

A layer is read off the **shape of the shelf name**:

| Layer | Name shape | Holds | Example |
|---|---|---|---|
| **Project** | `<situation>@<slug>` | Facts true only in one repo: its build quirks, CI rules, conventions. | `code-review@acme-app` |
| **Domain** | `<situation>` (no `@`) | Lessons about a kind of work that hold in *any* repo. | `code-review` |
| **Global** | one bare shelf your harness designates (`global` in the examples here) | Facts about the machine or the tools every agent uses, in every repo. | `global` |

Domain and global shelves look alike, since neither has an `@`. The harness, not
`nb`, decides which one bare name is the global shelf; every other bare name is a
domain shelf.

A project shelf reuses the name of the domain shelf it refines plus `@<slug>`, so
`nb list` shows the pair side by side (`code-review` and `code-review@acme-app`).
The slug is the text after the **last** `@`. Use exactly one `@` per name; see
[one slug per repo](#one-slug-per-repo).

## Which layer wins

When lessons from different layers disagree, **project beats domain beats global**:
the more specific shelf knows something the general one does not. This is an
instruction to the model, not something `nb` enforces. Put it in the standing
instructions you give agents, for example:

```text
If notebook lessons conflict, follow the project shelf (<situation>@<slug>)
over the domain shelf (<situation>) over the global shelf.
```

## Where a new lesson goes: narrowest layer first

Write a lesson to the **most specific shelf it is true for**. When unsure, that
is the project shelf. Promote it later, when there is evidence it holds more
widely.

The asymmetry is the reason. A lesson left in a project shelf too long costs one
repo a rediscovery. A lesson promoted too early sits in every agent's index and
may mislead agents in repos where it is false. Evidence that a lesson deserves a
wider layer:

- the same lesson appears in the shelves of two or more projects (the
  example [janitor](#janitor-signals-that-help), a read-only script that audits
  the notebooks, finds this for you), or
- it keeps a high score because agents in several repos vote it up, or
- it names no path, tool or rule specific to one repo.

Reserving the global shelf for promotion only (agents do not `nb add` to it
directly) keeps it short and trustworthy. That is a harness policy you can
enforce in a wrapper; `nb` will not.

## Promote a lesson with `nb move`

`nb move <from> <to> <id>` relocates a lesson **keeping its score**, which
`nb add` followed by `nb rm` cannot do (an `add` restarts at +1). Here is a
complete worked example. It uses a throwaway store, so it never touches your
real notebooks, and it runs as written from the root of a checkout of this repo
(the last command is the example janitor in `examples/`). Two project shelves hold
the same general lesson:

```sh
export NB_DIR="$(mktemp -d)"   # a scratch store; nothing below touches your real shelves
nb add code-review@acme-app "Run npm run lint before pushing: CI rejects unformatted files"
nb add code-review@acme-app "Give each OR'd guard condition its own test that flips only that condition"
nb add code-review@acme-web "Give each OR'd guard condition its own test that flips only that condition"
node examples/nb-janitor.mjs | grep -A5 "Exact duplicate lessons"
```

```text
── 8. Exact duplicate lessons across shelves that share a base name
  ⚠️  "Give each OR'd guard condition its own test that flips only that condition" appears in 2 shelves: code-review@acme-app (+1), code-review@acme-web (+1).
      → an exact match under nb's own duplicate rule (case, punctuation and spacing ignored). To keep one copy in the shared "code-review" shelf (the highest-scored copy keeps its score), then drop the rest:
        nb move code-review@acme-app code-review eb4b61
        nb rm code-review@acme-web eb4b61 --reason obsolete --note duplicate
```

The lesson is not specific to either repo, so promote one copy to the domain
shelf and remove the other:

```sh
nb move code-review@acme-app code-review eb4b61
nb rm code-review@acme-web eb4b61 --reason obsolete --note duplicate
nb list
```

`duplicate` is a reason code for `nb merge`, not for `nb rm`, so a duplicate
removed with `rm` is recorded as `--reason obsolete` plus a free-text
`--note duplicate`. If you instead try to move the second copy, `nb move` does
nothing: it prints `skipped (a near-duplicate already lives in …)`, leaves both
shelves unchanged, and still **exits 0**, so a script must read the message, not
the exit code.

### Check the target first

A full shelf (50 lessons by default) makes room for a moved lesson in two steps.
It **evicts its lowest-scored lesson** (the stalest one if scores tie), then
**lowers the score of the stalest lesson that remains by one point** and sends
that lesson to the end of the file. The moved
lesson is always admitted, even if it scores below everything already there. So
moving a mediocre lesson into a full shelf can push out a better one. Before
promoting into a shelf that may be full, look at what would go:

```sh
nb list code-review              # the second column is the lesson count; 50 is full
nb stale code-review --limit 1    # the first row after the header is the lesson a full shelf would evict
```

To see the effect without filling 50 lines, lower the cap with `NB_MAX_LINES`
(see [the README](../README.md#nb-max-lines), which also covers `NB_DIR` and `NB_MAX_CHARS`). The parentheses run
the block in a subshell, so the lowered cap does not leak into your shell:

```sh
(
  export NB_MAX_LINES=3
  nb add shared "Use the repo's merge method flag with gh pr merge"
  nb add shared "Quote every path in shell scripts"
  nb add shared "Pin the Node version in CI"
  nb add widget@acme-app "Rebuild the generated client before running its tests"
  nb vote widget@acme-app "generated client" -1       # +1 -> +0: below everything in "shared"
  nb stale shared --limit 1                            # the lesson that will be evicted
  nb move widget@acme-app shared "generated client"
)
```

```text
moved [+0] Rebuild the generated client before running its tests — "widget@acme-app" now 0 lines, "shared" now 3 lines (evicted lowest-scored from "shared": [+1] Use the repo's merge method flag with gh pr merge)
```

The moved lesson (score +0, the lowest) was admitted and a +1 lesson was
evicted. The second step is not in that message: `nb show shared` now lists
"Quote every path in shell scripts" at +0 instead of +1.

## One slug per repo

The project layer only works if every agent writes to the same slug for the same
repo. Two slugs for one repo (`code-review@app` and `code-review@acme-app`)
split its memory in two, and a hook that shows only `@acme-app` shelves hides
the other half from the very repo it describes.

- **Let the harness choose the slug once**, not each agent. A common recipe is
  the repo's `owner-repo` name, lowercase, derived from the git remote and
  exported as one environment variable (for instance `NB_PROJECT_SLUG`) that
  every hook and agent instruction reads.
- **Keep slugs lowercase.** A hook can compare slugs ignoring case, but `nb`
  does not: `code-review@Acme-App` and `code-review@acme-app` are different
  shelves. Newer versions refuse to create the second one because the two files
  would collide on macOS and Windows; older versions create both and split the
  memory.
- **Use exactly one `@` per name.** The example hook below reads the slug after
  the *last* `@`, while the janitor takes the shelf's base name from before the
  *first*; the two agree only when there is a single `@`.
- **Mind the 128-character limit** on shelf names: `<situation>@<owner-repo>`
  must fit.

If a repo already has two slugs, fold the short one into the long one with
`nb move`; the janitor prints the commands.

## Janitor signals that help

The example [janitor](harness-setup.md#the-janitor) (`examples/nb-janitor.mjs`,
read-only) has two checks aimed at exactly this convention
([FR-JANITOR-001](requirements.md#fr-janitor-001), [issue #362](https://github.com/jeanibarz/agent-notebook/issues/362)):

- **Possible slug drift** (section 2): the same base name under two slugs where
  the shorter is the longer with leading parts dropped (`code-review@app` and
  `code-review@acme-app`), with the `nb move` that would fold them together.
- **Exact duplicate lessons across project shelves** (section 8): a lesson held
  by two or more `@` shelves of one base, which is your cue that it is not
  specific to one project, with the `nb move` and `nb rm` that keep a single
  copy in the domain shelf.

Both are hints, not proof: two repos can share a short name, and a lesson
repeated in two shelves may be correct in each.

## An example hook that groups the index by layer

[`examples/hooks/claude-code/nb-session-start.sh`](../examples/hooks/claude-code/nb-session-start.sh)
has an optional layered variant, **off unless you set `NB_PROJECT_SLUG`**. Set it
to the repo's slug and the hook prints the index in three groups (project,
domain, global, in that order) instead of one flat list, after stating the
precedence and placement rule. The global shelf is `global` unless you set
`NB_GLOBAL_SHELF`. Other behavior, so it is safe to adopt:

- It ends with a line such as `1 shelf(s) for other projects hidden (slug:
  acme-app); nb list --limit 1000 shows all`, so a hidden shelf never looks like a missing one.
- If other projects' shelves are hidden and none end in `@<your-slug>`, it prints
  a NOTE telling you to check the slug, instead of a quietly empty project section.
- If `nb list --json` fails or is not JSON, it falls back to the flat index with
  a warning. A session start never errors.
- It only changes what the *index* shows. It never opens a shelf for the agent,
  and an agent's own `nb list` still shows everything, so treat the hiding as a
  convenience, not isolation.

See the
[hooks README](../examples/hooks/claude-code/README.md#optional-layered-index-project--domain--global)
for setup.

## What `nb` deliberately does not do

| Not in `nb` | Why |
|---|---|
| Layer metadata in a shelf file (a `layer:` header) | A lesson is a string and a score ([NG-004](requirements.md#ng-004)); the name already says the layer. |
| An `nb promote` command | `nb move` already relocates a lesson and keeps its score. |
| A scope filter (`nb list --project …`) | `@` stays an opaque part of the name. `nb list [prefix]` matches only the *start* of a name ([FR-LIST-002](requirements.md#fr-list-002)). Considered and deferred: the harness already owns the hook and the wrapper, so it can filter without `nb` having to define what a slug is. |
| Ordering shelves or composing a session's context by layer | Left to the caller. [Issue #286](https://github.com/jeanibarz/agent-notebook/issues/286) (closed) added batch `nb show --json` for exactly this, so a harness can assemble context itself, and kept ordering and budgeting out of `nb`. |
| Enforcing precedence, or protecting the global shelf | Which shelf is "global" and who may write it are harness policy. |

If you do need more than this page offers, filter `nb list --json` in your own
hook or wrapper, as the example hook does.
