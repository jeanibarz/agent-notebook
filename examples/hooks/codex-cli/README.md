# Codex CLI + agent-notebook

The integration needs one thing, the `AGENTS.md` instruction (section 1). The
git wrapper (section 2) and Codex's own lifecycle hooks (section 3) are optional.

## 1. The contract → `AGENTS.md` (enough on its own)

Codex automatically reads `AGENTS.md` files at the start of every session and
merges them: the global `~/.codex/AGENTS.md`, your repository root, and the
current working directory. Putting the notebook protocol there means every
session starts with the "list the notebooks, open what fits, retrospect at the
end" contract in context — which is all Codex needs; the agent runs `nb list`
itself. This is the route without hooks, and it works with any version of
agent-notebook.

```sh
# Global: applies to every project. The file ships in the npm package; the
# sed drops its opening comment.
sed '/^<!--/,/^-->/d' "$(npm root -g)/agent-notebook/examples/hooks/codex-cli/AGENTS.snippet.md" >> ~/.codex/AGENTS.md

# Or per-repo: paste the snippet into the repo's AGENTS.md.
```

The per-repository switch (`git config nb.enabled false`, see the
[harness guide](https://github.com/jeanibarz/agent-notebook/blob/main/docs/harness-setup.md#per-repository-onoff)) also reaches Codex
without hooks, through `nb list`: the snippet starts the task with `nb list`,
and in an off repository that prints one line telling the agent to skip the
notebook steps instead of the index. So a global snippet is fine; switch the
repositories you don't want with git config.

(If you also use Claude Code, note that `CLAUDE.md` can be a symlink to
`AGENTS.md` — one file, both tools, as this repository itself does.)

## 2. Per-change git history → the PATH wrapper

Independent of the harness, the [`nb-git-wrapper.mjs`](../../nb-git-wrapper.mjs)
gives you a commit per notebook change. Install it first on `PATH` as `nb`:

```sh
cp "$(npm root -g)/agent-notebook/examples/nb-git-wrapper.mjs" ~/.local/bin/nb-git-wrapper.mjs
NB_GLOBAL_ROOT="$(npm root -g)"; [ -d "$NB_GLOBAL_ROOT" ] || NB_GLOBAL_ROOT=   # bake the root only if it exists
printf '#!/bin/sh\nNODE_PATH="%s" exec node "$(dirname "$0")/nb-git-wrapper.mjs" "$@"\n' "$NB_GLOBAL_ROOT" > ~/.local/bin/nb
chmod +x ~/.local/bin/nb   # keep the .mjs name: an extensionless copy fails on older Node (e.g. 18, 22.5)
(cd "$(nb path)" && git init)          # make NB_DIR a repo once
```

On its first commit the wrapper seeds a default `.gitignore` (only if one is
absent — your own file is never touched), so the churning usage log, lock, and
other transient runtime files stay out of history.

Then schedule [`nb-backup.sh`](../../nb-backup.sh) to publish daily (see the
[harness guide](https://github.com/jeanibarz/agent-notebook/blob/main/docs/harness-setup.md#backup)).

## 3. (Optional) lifecycle hooks → `~/.codex/hooks.json`

Codex CLI has lifecycle hooks. Registered under `SessionStart` and `Stop`, the
Claude Code adapter [`nb-claude-hook.mjs`](../claude-code/nb-claude-hook.mjs) runs
unchanged under Codex: it injects `nb brief` (the notebook index) at the start
and asks once per session for the `nb retro` retrospective. It needs
agent-notebook 0.13.0-beta.1 or later. The steps, checked with Codex CLI 0.171.0
on Linux, are in the
[harness guide](https://github.com/jeanibarz/agent-notebook/blob/main/docs/harness-setup.md#optional-codex-hooks).
In short:

- Each hook's `command` is one string (`node "/path/to/nb-claude-hook.mjs" session-start --harness codex`, and `stop` likewise):
  Codex ignores the `args` field, so the adapter's `print-settings` block, which
  is written for Claude Code, does not work here.
- `--harness codex` labels the runs `codex.session-start` and `codex.stop` in the usage
  log. Hooks pasted before this change are recorded as `hook.*`, or as `claude-code.*`
  by an older adapter.
- Codex runs a hook only after you trust it, in an interactive `codex` session
  (the "Hooks need review" screen, or `/hooks` then `t`). `codex exec` skips an
  untrusted hook without a message, so check for the `hook: SessionStart` line
  in its output. Editing a hook withdraws its trust.
- Keep the `AGENTS.md` snippet: it covers any session where the hooks do not run.

Codex also has plugins (`codex plugin`), but agent-notebook ships none for Codex.
