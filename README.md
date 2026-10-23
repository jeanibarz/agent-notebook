# agent-notebook

A bounded, voted, plain-text memory for AI agents — one small file per role, no embeddings, no vector DB, no network call.

```
$ nb add reviewer "run lint before claiming done"
added — 1 lines

$ nb show reviewer
3f9a2c  [+1]  run lint before claiming done

$ nb vote reviewer 3f9a2c +1
+1 → [+2] run lint before claiming done
```

## Why

Most "agent memory" tooling reaches for a vector database the moment anyone says the word "memory." Most agents don't need one. If what you actually want is "let this agent remember a handful of short, durable lessons across runs," a notebook is enough: a capped, append-and-vote text file that a human can `cat`, `grep`, and diff in git.

`agent-notebook` is the whole mechanism, nothing more:

- **One entry = one line.** `<score>\t<lesson>`, at most 200 characters, no multi-paragraph notes.
- **Bounded.** At most 200 lines per role. When full, the lowest-scored line is evicted first — harmful or useless lessons leave, useful ones survive.
- **Voted, not aged.** An agent votes +1/-1 on a lesson it used. No decay curve, no relevance scoring, no scheduler.
- **Plain text.** `~/.agent-notebook/notebooks/<role>.md`. Readable, diffable, greppable, backed up by whatever already backs up your home directory.

## What it deliberately does not do

Naming the non-goals matters more than listing features — if any of this is what you need, this is the wrong tool:

- No embeddings, no semantic search, no similarity ranking.
- No long-form notes, summaries, or documents — one line, period.
- No network calls, no server, no sync between machines.
- No multi-field schema — a lesson is a string, a score is an integer.

If you need retrieval over large unstructured context, use a real vector store. This solves a narrower problem: a short list of hard-won, durable lessons an agent should keep seeing.

## Install

```
npm install -g agent-notebook
```

(Or run it straight out of a clone — see Development below. Not yet on the npm registry; see Status.)

## Usage

```
nb show   <role>                        print the notebook (highest-scored first)
nb add    <role> "<lesson>"             add a lesson (dedup-skipped; rejected if too long, never truncated)
nb vote   <role> <id|query> +1|-1       upvote/downvote an entry you used
nb merge  <role> <idA> <idB> "<merged>" consolidate two entries into one
nb rm     <role> <id|query>             delete an entry
nb stats  [<role>] [--since 7d]         usage analytics + anomaly flags
nb --help                               show this help
```

Every `show` line starts with a short stable id — pass that id (or a unique prefix, or a unique text substring) to `vote`/`rm`/`merge`. An over-long `add` is rejected outright, never silently truncated, so you rewrite it shorter instead of storing a cut-off, useless lesson.

`NB_DIR` overrides the storage directory (default `~/.agent-notebook/notebooks`); `NB_MAX_LINES` and `NB_MAX_CHARS` override the caps, if you need something other than 200/200.

## Programmatic use

```ts
import { addEntry, readEntries, vote, render } from 'agent-notebook';

await addEntry(dir, 'reviewer', 'run lint before claiming done');
const entries = readEntries(dir, 'reviewer');
```

The CLI is a thin wrapper over this library — `src/notebook.ts` is the whole mechanism, with zero runtime dependencies.

## Status

Early. This started as an internal tool for a multi-agent orchestrator and is being published to see whether the underlying idea — bounded, voted, one-line memory — is useful outside that specific context. It's not yet on the npm registry, and there's no marketing push behind it: if you find it because you were already looking for something like this, that's the signal this is worth taking further. Issues and forks are welcome either way.

## Contributing

The entire point is that this stays small. A PR that adds a feature should make the case for why the bounded/voted/one-line model needs it, not just that it would be nice to have. Bug fixes, docs, and test coverage are always welcome.

## License

MIT
