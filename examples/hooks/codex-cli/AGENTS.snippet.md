<!--
  Paste this block into the AGENTS.md that Codex CLI already reads — either your
  repo-root AGENTS.md or the global ~/.codex/AGENTS.md. Codex loads these files
  automatically at the start of every session, which IS the injection mechanism:
  unlike Claude Code, Codex has no SessionStart/Stop hooks, so the contract lives
  in the instructions, and the per-change git history comes from the PATH wrapper.
  Replace <role> with a fixed role, or tell Codex to use the repo's name.
-->

## Memory: agent-notebook (`nb`)

You have a bounded, voted, plain-text memory via the `nb` command. Use it:

- **At the start of a task**, read your experience first:
  `nb show <role>` and, if a different role fits better, `nb list`.
- **During the task**, for a *known-item* lookup only, `nb search "<keywords>"`
  (surfacing is primary; search is the fallback).
- **At the end of the task — a short retrospective (do this before you finish):**
  1. `nb vote <role> <id> +1` for each lesson that actually helped.
  2. `nb vote <role> <id> -1 --reason wrong` for any shown to you that misled.
  3. `nb rm <role> <id> --reason obsolete` for anything incorrect / no longer true.
  4. `nb merge` / `nb split <role> …` only if the notebook is cluttered or full.
  5. `nb add <role> "<=200-char lesson>"` — at most ONE genuinely new, non-obvious
     lesson you'd want shown to you next time. Adding nothing is fine; never pad.

Write each lesson as one concrete, actionable line (a trap + its mechanism), not
a vague reminder. An over-long `add` is rejected, not truncated — rewrite shorter.
