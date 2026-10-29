---
name: agent-notebook-setup
description: >-
  Guide a user through installing and configuring agent-notebook in their AI
  harness (Claude Code or Codex CLI, on Linux/macOS/Windows) — the "list & open"
  instruction that makes the agent use it, optional session-start/retrospective
  hooks, per-change git-versioning, daily backup, and the diagnostics janitor.
  Use when the user says things like "set up / install
  / configure agent-notebook", "wire the notebook into my harness", "add the nb
  hooks", "how do I get my agent to use the notebook automatically", or asks about
  git-versioning, backup, or the janitor for agent-notebook.
---

# Guide the user through setting up their agent-notebook harness

You are walking a user through turning on `agent-notebook`. Be concrete and
hands-on: detect their situation, run or hand them the exact commands, verify
each step worked. The full reference is `docs/harness-setup.md`; this skill is
the interactive path through it.

## 1. Orient (ask only what you can't detect)

Determine, by asking or inspecting:
- **Harness:** Claude Code, Codex CLI, or both?
- **OS:** Linux, macOS, or Windows (WSL / Git Bash / native)?
- **How far they want to go.** Offer the ladder and let them pick a stopping point:
  1. install `nb`, 2. + the "list & open" instruction so the agent uses it (the
  core), 3. + optional convenience hooks, 4. + git-versioning, 5. + daily backup
  to a remote, 6. + the janitor.

Don't over-ask. If they're on the machine you can see, check `node --version`,
`command -v nb`, and `nb path` yourself first.

## 2. Install the base

```sh
node --version                 # need ≥ 18
npm install -g agent-notebook
nb --help
```

Confirm `nb add smoke "test" && nb show smoke && nb rm smoke "test"` round-trips.

## 3. Give the agent the instruction (the core — this is what makes it get used)

The required step is just putting the "list the notebooks, open what fits,
retrospect at the end" contract where the harness reads standing instructions.
There is no per-project "shelf" to configure.

- **Claude Code:** put the contract in a `CLAUDE.md` it auto-loads — simplest is
  `cp <repo>/AGENTS.md ./AGENTS.md && ln -s AGENTS.md CLAUDE.md` (project), or the
  same in `~/.claude/`. That alone works: the agent runs `nb list` itself.
- **Codex CLI:** `cat examples/hooks/codex-cli/AGENTS.snippet.md >> ~/.codex/AGENTS.md`
  (Codex auto-loads `AGENTS.md`). That is the whole integration for Codex.
- **Both:** `ln -s AGENTS.md CLAUDE.md` lets one file serve both.
- **Optional hooks (Claude Code only):** copy `examples/hooks/claude-code/` scripts,
  `chmod +x`, and merge the `settings.json` `hooks` block into `.claude/settings.json`,
  replacing `/ABSOLUTE/PATH`. Explain they are *conveniences*: `SessionStart`
  injects the `nb list` index (no shelf logic); `Stop`/`SubagentStop` nudges the
  retrospective once per session. Skipping them changes nothing essential.
- **Subagents:** no hook and no shelf assignment — a subagent reads the same
  contract and runs `nb list` for its own task (`docs/harness-setup.md#subagents`).

## 4. git-versioning (optional)

Walk them through `docs/harness-setup.md#git-versioning`: `git init` in
`$(nb path)`, the `.gitignore`, and installing `examples/nb-git-wrapper.mjs` as
`nb` on PATH so each change commits. Verify with `git -C "$(nb path)" log --oneline`.

## 5. Backup (optional)

Only if they want memory off the machine or shared. Set a **private** remote,
then schedule `examples/nb-backup.sh` (cron on Linux/macOS/WSL; Task Scheduler on
native Windows — `docs/harness-setup.md#windows`). For an org, route them to
`docs/enterprise.md#where-the-remote-lives` to choose the remote deliberately.

## 6. Janitor (optional)

Show `node examples/nb-janitor.mjs`, explain the four sections, and suggest a
weekly cadence. It is read-only and safe.

## 7. Verify and hand off

Run the checklist in `docs/harness-setup.md#verify-its-working`. Then tell them to
start a fresh harness session and confirm the agent runs `nb list` and opens a
relevant notebook on its own (and, if they added the optional hooks, that the index
is injected at the top and a retrospective is nudged at the end).

## Rules

- Prefer running/verifying commands over pasting walls of text; adapt paths to
  their actual OS and harness. Never invent a step not in the docs.
- If they have data-sovereignty or security constraints, switch to
  `docs/enterprise.md` before configuring any remote.
- If `nb` is already set up, don't redo it — detect state and only fill gaps.
