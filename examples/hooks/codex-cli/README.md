# Codex CLI + agent-notebook

Codex CLI does not expose per-event lifecycle hooks the way Claude Code does, so
the integration leans on the two levers Codex *does* give you. Both are simple.

## 1. The contract → `AGENTS.md` (this is the whole integration)

Codex automatically reads `AGENTS.md` files at the start of every session and
merges them: the global `~/.codex/AGENTS.md`, your repository root, and the
current working directory. Putting the notebook protocol there means every
session starts with the "list the notebooks, open what fits, retrospect at the
end" contract in context — which is all Codex needs; the agent runs `nb list`
itself.

```sh
# Global: applies to every project.
cat AGENTS.snippet.md >> ~/.codex/AGENTS.md

# Or per-repo: paste the snippet into the repo's AGENTS.md.
```

(If you also use Claude Code, note that `CLAUDE.md` can be a symlink to
`AGENTS.md` — one file, both tools, as this repository itself does.)

## 2. Per-change git history → the PATH wrapper

Independent of the harness, the [`nb-git-wrapper.mjs`](../../nb-git-wrapper.mjs)
gives you a commit per notebook change. Install it first on `PATH` as `nb`:

```sh
cp ../../nb-git-wrapper.mjs ~/.local/bin/nb && chmod +x ~/.local/bin/nb
(cd "$(nb path)" && git init)          # make NB_DIR a repo once
```

Then schedule [`nb-backup.sh`](../../nb-backup.sh) to publish daily (see the
[harness guide](../../../docs/harness-setup.md#backup)).

## 3. (Optional) end-of-turn reminder → `notify`

Codex's `notify` config runs a program when a turn finishes. It is meant for
desktop notifications, not for feeding text back to the model, so it cannot
*force* a retrospective the way a Claude Code `Stop` hook can — the reliable
place for the retrospective instruction is the `AGENTS.md` snippet above. If you
still want a visible nudge, point `notify` at a script that prints the checklist:

```toml
# ~/.codex/config.toml
notify = ["/ABSOLUTE/PATH/nb-notify.sh"]
```

Keep the retrospective itself in `AGENTS.md`; treat `notify` as a convenience,
not the mechanism.
