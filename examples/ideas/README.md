# Ideas store (stub)

`nb-ideas.mjs` wraps the `nb` CLI to keep a separate notebooks folder of
improvement ideas, one line each:
`<target>: <problem> -> <change> (keeps: <behaviour that must keep working>)`.
Run `node nb-ideas.mjs help` for the commands. The full guide will replace this stub.

## Environment

| Var | Default | Meaning |
|---|---|---|
| `NB_IDEAS_DIR` | `~/.agent-notebook/ideas` | the ideas folder, a notebooks folder of its own (a leading `~` is expanded). Read by `nb-ideas.mjs` and `nb-ideas-stop.sh` |
| `NB_IDEAS_MAX_CHARS` | `400` | line cap, passed to `nb` as `NB_MAX_CHARS` |
| `NB_IDEAS_MAX_LINES` | `50` | per-shelf cap, passed to `nb` as `NB_MAX_LINES` |
| `NB_IDEAS_PROJECT` | basename of the git root of the working directory | project slug (lower-cased); the `--project` flag wins |
| `NB_IDEAS_SIMILARITY` | `0.4` | `add` refuses (exit 3) an idea at least this similar to an existing one |
| `NB_IDEAS_PROMOTE_SCORE` | `3` | `support`: minimum score to be promotable |
| `NB_IDEAS_PROMOTE_TASKS` | `2` | `support`: minimum distinct supporting tasks to be promotable |
| `NB_IDEAS_BIN` | `nb-ideas` | the command `nb-ideas-stop.sh` runs to get the end-of-task prompt |
| `NB_SESSION` | unset | the task id: turns on the per-task rules and the support counts |
| `NB_BIN` | the package's own `nb` | the `nb` command `nb-ideas.mjs` runs (for example the git wrapper); `nb-ideas-stop.sh` uses it for `nb enabled` |
| `NB_RETRO_TTL_DAYS` | `7` | days an `.ideas-prompt-<session>` sentinel survives before `nb-ideas-stop.sh` prunes it |

`nb-ideas.mjs` never reads the caller's `NB_DIR`, `NB_MAX_CHARS` or `NB_MAX_LINES`:
it sets all three for the `nb` it runs, from the `NB_IDEAS_*` values above.
