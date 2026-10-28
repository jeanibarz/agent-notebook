---
name: agent-notebook-explain
description: >-
  Explain what agent-notebook is, why it exists, and how its bounded/voted/
  one-line memory model works — pitched to the audience in front of you, from
  non-technical to engineer. Use when the user asks "what is agent-notebook",
  "how does the notebook work", "why not a vector database", "what's the point of
  this", "explain the voting / eviction / surfacing", or wants a walkthrough of the
  concept rather than installation steps.
---

# Explain agent-notebook clearly

Teach the idea; don't dump the docs. Calibrate depth to the reader, build from
the one-sentence idea, and offer to go deeper or to switch to setup.

## Start with the core idea (always)

> Give an AI assistant a small notebook where it writes the lessons it learns, so
> next time it does a similar job it starts already knowing them.

Then the design in four facts — this *is* the whole mechanism:

1. **One lesson = one line** (≤200 chars). Not a document; a hard-won reminder.
2. **A score, set by votes.** +1 when a lesson helped, −1 when it misled. Good
   lessons float up.
3. **Bounded (≤200 lines).** When full, the *lowest-scored* line is evicted — so
   it self-cleans and never becomes a junk drawer.
4. **Plain text, shown not searched.** It's a file you can read, edit, and
   `git diff`; the harness *injects* it at task start rather than making the
   agent query it.

## The one insight worth landing

The point of memory isn't to answer questions the agent knows to ask — it's to
put back in front of it the trap it *forgot exists*. A search engine only returns
what you can already name; a notebook is pushed to the agent unasked. That's why
"no embeddings / no vector DB" is a feature, not a limitation — for a handful of
durable lessons, pushing beats searching.

Name the honest boundary too: if they need recall over thousands of documents,
that's genuine large-scale retrieval — use a vector store. This does one small
thing well.

## Match the audience

- **Non-technical:** use the analogies and diagrams in `docs/getting-started.md`.
  Avoid jargon; a "role" is just "a kind of job."
- **Engineer / evaluator:** go to the model and guarantees — content-derived
  stable ids, insertion-order storage vs score-ordered display, the usage log and
  `nb stats` surfacing metrics, zero runtime deps. Source: `README.md`,
  `docs/requirements.md`, `docs/self-observing-notebook.md`.
- **Security / platform:** lead with the architecture (no server, no network, no
  deps; data is text files you govern) — `docs/enterprise.md`.

## Offer the next step

Close by offering to (a) go deeper on any piece, (b) show a 2-minute hands-on
(`npm install -g agent-notebook`; add/show/vote), or (c) set it up in their
harness — in which case use the `agent-notebook-setup` skill.

Keep it honest: never oversell. The tool's credibility is that it refuses to be
more than it is.
