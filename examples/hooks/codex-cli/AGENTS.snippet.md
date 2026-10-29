<!--
  Paste this block into the AGENTS.md that Codex CLI already reads — either your
  repo-root AGENTS.md or the global ~/.codex/AGENTS.md. Codex loads these files
  automatically at the start of every session, which IS the integration: unlike
  Claude Code, Codex has no lifecycle hooks, so the contract lives in the
  instructions, and the per-change git history comes from the PATH wrapper. No
  per-project notebook name to configure — the agent lists the notebooks and opens what
  fits.
-->

## Memory: agent-notebook (`nb`)

You have a bounded, voted, plain-text memory via the `nb` command. Use it:

- **At the start of a task**, run `nb list` to see every notebook and its one-line
  description, then `nb show <shelf>` the one(s) whose description fits your task,
  and keep their lessons in front of you. (Surfacing from the index is the primary
  path; `nb search "<keywords>"` is a fallback for a known-item lookup.)
- **At the end of the task — a short retrospective (do this before you finish),**
  on the notebooks you opened:
  1. `nb vote <shelf> <id> +1` for each lesson that actually helped. (The `<id>` is
     the short code `nb show` prints; a unique snippet of the lesson text works too.)
  2. `nb vote <shelf> <id> -1` for any shown to you that misled. (`vote` takes no
     `--reason`; record *why* on the `rm` below.)
  3. `nb rm <shelf> <id> --reason obsolete` for anything incorrect / no longer true.
  4. `nb merge` / `nb split <shelf> …` only if a notebook is cluttered or full.
  5. `nb add <shelf> "<=200-char lesson>"` — at most ONE genuinely new, non-obvious
     lesson, to the notebook it fits. Adding nothing is fine; never pad.

Write each lesson as one concrete, actionable line (a trap + its mechanism), not
a vague reminder. An over-long `add` is rejected, not truncated — rewrite shorter.
