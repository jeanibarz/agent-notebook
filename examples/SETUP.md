# Set up agent-notebook

This guide is for an AI coding agent. A user said "set up agent-notebook". Follow the steps in order. Run each command. After each step, run its "Check:" line and compare the output. If a check fails, go to [Troubleshooting](#5-troubleshooting) and do not go on.

Every command is for macOS, Linux, WSL or Git Bash. Run the commands in the user's project directory unless a step says otherwise. The sample outputs use `my-app` as the project name and `<home>` for the home folder. Your output will differ in those parts only.

Background, when you need it: [README](https://github.com/jeanibarz/agent-notebook), [two use cases: lessons and ideas](https://github.com/jeanibarz/agent-notebook/blob/main/docs/ideas-store.md), [harness setup](https://github.com/jeanibarz/agent-notebook/blob/main/docs/harness-setup.md).

## 0. Pick a path

Ask the user which path they want. If they did not say, use A.

- **A. Lessons only.** Agents read the notebooks at the start of a task and vote on what helped at the end. Each lesson is one line of 200 characters at most. The notebook is bounded: the lowest score leaves first.
- **B. Ideas only.** At the end of a task, an agent records at most one simplification idea, and only when the task showed something to delete, merge, shorten, split, correct or make fail loudly. Most tasks record nothing. Ideas are never shown at the start of a task. A curator reads them and promotes the well-supported ones to work items. This use case is a trial.
- **C. Both.** Do path A, then path B, then read [section 4](#4-path-c-both).

Everyone does section 1. Then do section 2 (A), section 3 (B), or both (C).

## 1. Prerequisites and install

1. Check that Node.js is version 18 or newer.

   ```sh
   node --version
   ```

   Check: the output is `v18.0.0` or higher, for example `v22.11.0`. If not, ask the user to install Node 18+ and stop.

2. Install the package. It provides the `nb` command and ships the files used below.

   ```sh
   npm install -g agent-notebook
   ```

   Check: `nb --version` prints `nb (agent-notebook) ` followed by a version number, for example `nb (agent-notebook) 0.12.0`.

3. Check that the shipped files are where this guide says.

   ```sh
   ls "$(npm root -g)/agent-notebook/examples"
   ```

   Check: the list includes `hooks`, `README.md` and `SETUP.md`. If `npm root -g` points at the wrong place (for example you installed with a custom prefix), use the folder that holds `agent-notebook/` wherever `$(npm root -g)` appears below.

## 2. Path A: lessons

Lessons use the default folder, `~/.agent-notebook/notebooks`. Set `NB_DIR` to use another folder. The default 200-character cap stays as it is.

1. Find the lessons folder.

   ```sh
   nb path
   ```

   Check: it prints the folder, for example `<home>/.agent-notebook/notebooks`. Run `nb list` too: on a fresh machine it prints ``no notebooks yet — add one with `nb add <shelf> "<lesson>"` ``.

2. (Optional) Create a first shelf and say when to open it. A shelf is a notebook name: short, no spaces. The description appears in the index that agents read.

   ```sh
   nb add my-app "run the formatter before the tests; CI fails on style first"
   nb describe my-app "open when working in my-app: build, test and CI gotchas"
   ```

   Check: `nb list` prints a header line, then `  my-app  1  open when working in my-app: build, test and CI gotchas`.

3. Give the agent the standing instruction. Run the command for the user's harness, in the project. If `CLAUDE.md` is a link to `AGENTS.md`, run only one. Each command skips a file that already has the block.

   Claude Code reads `CLAUDE.md`:

   ```sh
   grep -qs '^## Memory: agent-notebook' CLAUDE.md || sed '/^<!--/,/^-->/d' "$(npm root -g)/agent-notebook/examples/hooks/codex-cli/AGENTS.snippet.md" >> CLAUDE.md
   ```

   Codex CLI reads `AGENTS.md` (in the project, or `~/.codex/AGENTS.md` for every project):

   ```sh
   grep -qs '^## Memory: agent-notebook' AGENTS.md || sed '/^<!--/,/^-->/d' "$(npm root -g)/agent-notebook/examples/hooks/codex-cli/AGENTS.snippet.md" >> AGENTS.md
   ```

   Check (use the file you wrote to): `grep -n '^## Memory' CLAUDE.md` prints ``2:## Memory: agent-notebook (`nb`)``. The line number can differ. Running the command a second time must not add a second block: `grep -c '^## Memory' CLAUDE.md` prints `1`.

4. (Optional, Claude Code only.) Add the hooks. They inject the notebook index at session start, hand it to each subagent, and ask for the retrospective at the first stop. Skip this step for Codex CLI.

   Copy the scripts somewhere stable. The three `.sh` scripts run `nb-claude-hook.mjs`, so copy the four files together.

   ```sh
   mkdir -p ~/.agent-notebook/hooks
   cp "$(npm root -g)/agent-notebook/examples/hooks/claude-code/"nb-* ~/.agent-notebook/hooks/
   chmod +x ~/.agent-notebook/hooks/*.sh
   ```

   Check: `ls ~/.agent-notebook/hooks` lists `nb-claude-hook.mjs`, `nb-retrospective.sh`, `nb-session-start.sh` and `nb-subagent-start.sh`.

   Print the hooks block with your paths filled in.

   ```sh
   sed -e '/^  "\/\//d' -e "s|/ABSOLUTE/PATH/examples/hooks/claude-code|$HOME/.agent-notebook/hooks|" "$(npm root -g)/agent-notebook/examples/hooks/claude-code/settings.json"
   ```

   Check: it prints JSON that starts `{` / `"hooks": {` and has `SessionStart`, `SubagentStart` and `Stop`, each with a `command` that starts with the user's home folder and ends in one of the copied scripts.

   Merge the `hooks` block into `.claude/settings.json` (this project) or `~/.claude/settings.json` (every project). If the file already has a `hooks` key, add these entries to its arrays instead of replacing them. If the file does not exist, create `.claude/` and save the printed block as the whole file. For path C (both), skip this merge and write the complete file shown in section 4 once, after section 3. Then restart Claude Code: hooks load at startup. In the new session, the `/hooks` command lists the registered hooks. The hooks run `node` and `nb`, so both must be on the `PATH` Claude Code starts with; `NB_BIN` takes a full path to `nb` instead. Tell the user before you edit their settings file.

5. Verify. Run the session-start hook by hand.

   ```sh
   bash ~/.agent-notebook/hooks/nb-session-start.sh | head -3
   ```

   Check: the first line is `## Your agent-notebook index`.

   Then send a Stop payload to the retrospective hook. Use a temporary folder, so the test leaves nothing in the lessons folder.

   ```sh
   T=$(mktemp -d)
   echo '{"session_id":"test-1","hook_event_name":"Stop","cwd":"'"$PWD"'"}' | NB_DIR=$T bash ~/.agent-notebook/hooks/nb-retrospective.sh
   ```

   Check: it prints one JSON line that starts `{"decision":"block","reason":"Before finishing, run the agent-notebook retrospective`. Run the same command again with the same `T`: it prints nothing (the hook asks once per session).

### Your own start and end text (optional)

To add your own words to the start-of-session and end-of-task text, put `brief.txt`, `retro.txt`, or `<project>.brief.txt` / `<project>.retro.txt` in `~/.agent-notebook/messages/`. It needs the new hooks, not copied 0.12 scripts. See [the hooks README](https://github.com/jeanibarz/agent-notebook/blob/main/examples/hooks/claude-code/README.md#your-own-start-and-end-text). If you use project files, set `NB_PROJECT_SLUG` per project, in that project's `.claude/settings.local.json` `env` block, never machine-wide: a machine-wide value makes one project's file apply in every project.

## 3. Path B: ideas

Ideas live in a separate folder, `~/.agent-notebook/ideas`, and are read through a command named `nb-ideas`. It is plain `nb` pointed at that folder. `nb` has no notion of an "ideas" kind. The folder is kept apart from lessons for three reasons:

- The session-start index, `nb stats` and the janitor read one folder. A mixed folder would show ideas to every agent at the start of every task.
- An idea line needs up to 400 characters. A lesson needs 200. The line length is set per folder, so lessons cannot grow.
- A separate folder lets a curator read ideas without touching lessons.

The design is the accepted [RFC 0530](https://github.com/jeanibarz/agent-notebook/blob/main/docs/rfcs/0530-notebook-kinds.md).

1. Create the folder and set its line length.

   ```sh
   mkdir -p ~/.agent-notebook/ideas
   printf '{ "maxChars": 400 }\n' > ~/.agent-notebook/ideas/.nb.json
   ```

   Check: `cat ~/.agent-notebook/ideas/.nb.json` prints `{ "maxChars": 400 }`.

2. Install the `nb-ideas` command. It is a two-line shim on `PATH`, not a shell alias, because agents and hooks run non-interactive shells that do not load aliases.

   ```sh
   mkdir -p ~/.local/bin
   printf '#!/bin/sh\nNB_DIR="$HOME/.agent-notebook/ideas" exec nb "$@"\n' > ~/.local/bin/nb-ideas && chmod +x ~/.local/bin/nb-ideas
   ```

   `~/.local/bin` must be on `PATH`. If it is not, add `export PATH="$HOME/.local/bin:$PATH"` to the shell profile.

   Check, from a non-interactive shell, which is what an agent has: `sh -c 'command -v nb-ideas'` prints `<home>/.local/bin/nb-ideas`. Also run `sh -c 'command -v nb'`: it must print a path too, because the shim calls `nb`. If either prints nothing, fix `PATH` before you go on.

3. Check that `nb` reads the folder's line length.

   ```sh
   nb-ideas path
   nb-ideas config | grep '^maxChars'
   ```

   Check: `nb-ideas path` prints `<home>/.agent-notebook/ideas`, and the `config` line is `maxChars=400` tagged `(.nb.json)`. That tag means this `nb` reads `.nb.json`, and you are done with this step.

   If the line is `maxChars=200 (default)` instead, this `nb` is older than `.nb.json` support (0.11.1 and earlier) and ignores the file. Rewrite the shim so it also sets the length, and keep the file for when you upgrade:

   ```sh
   printf '#!/bin/sh\nNB_MAX_CHARS=400 NB_DIR="$HOME/.agent-notebook/ideas" exec nb "$@"\n' > ~/.local/bin/nb-ideas && chmod +x ~/.local/bin/nb-ideas
   ```

   Check again: the line is now `maxChars=400` tagged `(env NB_MAX_CHARS)`. With this fallback, only calls made through the shim get 400; plain `nb` with `NB_DIR` set to the ideas folder still uses 200.

4. Smoke test. A shelf is a notebook, named `<category>@<project>`, for example `dead@my-app`. It is created by the first add: there is nothing to create by hand. This test adds a line of 246 characters, which a 200-character folder would refuse, then removes it.

   ```sh
   nb-ideas add dead@setup-test "scripts/old-deploy.sh: nothing has called it since CI moved to the hosted pipeline, and it still exports three variables that no other file reads, so readers assume it matters -> delete the file and the three exports (keeps: npm run deploy works)"
   ```

   Check: it prints `added — 1 line` and `note: created new shelf "dead@setup-test"`. If it prints `lesson too long`, see [Troubleshooting](#5-troubleshooting).

   ```sh
   nb-ideas doctor
   nb-ideas rm dead@setup-test "scripts/old-deploy.sh" --reason other --note "setup test"
   nb-ideas list
   ```

   Check: `doctor` prints `nb doctor: OK — 1 shelf checked, no problems found`. `rm` prints `removed — [+1] scripts/old-deploy.sh: nothing has called it ...`. Removing a shelf's last line removes the shelf, so the last `list` prints ``no notebooks yet — add one with `nb add <shelf> "<lesson>"` ``.

5. (Optional) Say what a shelf is for. Shelves are created by the first add, without a description. A description shows in `nb-ideas list`.

   ```sh
   nb-ideas describe dead@my-app "code, flag, file, script or config that nothing uses: delete it"
   ```

   Check: it prints `description set for shelf "dead@my-app": code, flag, file, script or config that nothing uses: delete it`. (It creates the shelf if it does not exist yet.)

6. Ask for an idea at the end of a task. Choose by harness.

   **Claude Code.** The Stop hook that sends the lessons retrospective can append a second text to the same nudge. There is one hook and one nudge per session. Register `nb-retrospective.sh` as in path A, step 4 (copy it, merge the printed hooks block, restart). Then copy the ideas prompt next to it:

   ```sh
   mkdir -p ~/.agent-notebook/hooks
   cp "$(npm root -g)/agent-notebook/examples/hooks/ideas-end-prompt.txt" ~/.agent-notebook/hooks/
   echo "$HOME/.agent-notebook/hooks/ideas-end-prompt.txt"
   ```

   Check: the `echo` prints `<home>/.agent-notebook/hooks/ideas-end-prompt.txt`. This is an absolute path. Use it in the next paragraph.

   Add `NB_RETRO_EXTRA_PROMPT` to the `env` block of `~/.claude/settings.json` (or `.claude/settings.json` for one project), with that absolute path. Create the `env` block if it is not there, and keep the other keys. Never set it in a notebooks folder.

   ```json
   {
     "env": {
       "NB_RETRO_EXTRA_PROMPT": "<home>/.agent-notebook/hooks/ideas-end-prompt.txt"
     }
   }
   ```

   Restart Claude Code. Then verify. Send a Stop payload whose `cwd` is a git repository, with a temporary folder for the sentinel. The `cut` keeps the end of the reason.

   ```sh
   T=$(mktemp -d)
   echo '{"session_id":"test-1","hook_event_name":"Stop","cwd":"'"$PWD"'"}' | NB_RETRO_EXTRA_PROMPT="$HOME/.agent-notebook/hooks/ideas-end-prompt.txt" NB_DIR=$T bash ~/.agent-notebook/hooks/nb-retrospective.sh | node -pe 'JSON.parse(require("fs").readFileSync(0)).reason.split("\n").slice(-9).join("\n")'
   ```

   Check: it prints the end of the nudge, starting with an empty line, then `One more check before you stop, on the project acme-my-app (not the notebooks):`, where `acme-my-app` stands for the name `nb project` prints in that repository (here for an `origin` of `git@github.com:acme/my-app.git`; `my-app` for a repository without a remote). One line names the add command, with the project and the session filled in: `NB_SESSION=test-1 nb-ideas add <category>@acme-my-app "<file or command>: <problem> -> <change> (keeps: <behaviour that must keep working>)"`. The last line is `Do not read the ideas shelves first.` Run the same command again with the same `T`: the hook prints nothing, because the sentinel `.retro-test-1` now exists in `T` (if you kept a `| node …` filter on the end, it then fails on the empty input; that is expected).

   How the hook fills the placeholders:

   - `{project}` is the name `nb project` prints there: the git `origin` remote as `owner-repo` (`git@github.com:acme/my-app.git` gives `acme-my-app`), or, without a remote, the folder that holds the repository's `.git`, lower-cased, with characters outside `a-z0-9._-` replaced by `-`. A main checkout and its worktrees give the same name, so they share shelves. Run `nb project` in the repository to see it.
   - `{session}` is the `session_id` from the payload.
   - If the folder is not a git repository, or there is no `session_id`, the hook leaves the ideas text out and sends the lessons nudge alone. If the prompt file is missing, relative or unreadable, the hook warns on stderr and does the same.

   Two repositories without a remote whose folders have the same name would share shelves. To tell them apart, set `NB_PROJECT_SLUG` for each project, in that project's `.claude/settings.json` `env` block. Never set it at user level: every project would then get the same name. `NB_PROJECT_SLUG` also turns on the [layered index](https://github.com/jeanibarz/agent-notebook/blob/main/examples/hooks/claude-code/README.md#optional-layered-index-project--domain--global) of the session-start hook, so set it only when the user wants that too. Without it, `nb brief` also shows the layered index once a shelf name in the store contains `@` and the repository has an `origin` remote (the name from the remote); a folder name never turns it on.

   **Codex CLI and other harnesses.** They have no Stop hook. Append the prompt text to `AGENTS.md` (or the harness's instruction file), with the project name filled in by hand. Replace `my-app` with what `nb project` prints in the repository. The `sed` drops the `NB_SESSION={session} ` prefix, because there is no session id to fill in. If the harness has one, keep the prefix and put the id in by hand. The `grep` skips a file that already has the section.

   ```sh
   grep -qs '^## Ideas: end of task' AGENTS.md || { printf '\n## Ideas: end of task\n\n'; sed -e 's/{project}/my-app/g' -e 's/NB_SESSION={session} //' "$(npm root -g)/agent-notebook/examples/hooks/ideas-end-prompt.txt"; } >> AGENTS.md
   ```

   Check: `grep -c '^## Ideas: end of task' AGENTS.md` prints `1`, also after a second run. `grep -n 'nb-ideas add' AGENTS.md` prints one line: `  nb-ideas add <category>@my-app "<file or command>: <problem> -> <change> (keeps: <behaviour that must keep working>)"`, with a line number in front. `grep -c '{project}' AGENTS.md` prints `0`.

7. Hand the curator recipe to the user. It is the only way ideas become work.

   **The curator is the voter.** Agents only add, and they never vote on ideas. Without votes every line has score 1, and a full shelf (50 lines) drops its oldest line first. The curator's votes are what keep an idea on the shelf. Once a week, or sooner when any shelf reaches 40 lines (`nb-ideas list` shows the counts), a person or an agent does this for each project:

   1. Read the project's shelves: `nb-ideas list` shows them with their line counts; `nb-ideas show <shelf>` each one that has lines. An empty shelf needs nothing.
   2. Handle each line:
      - **A later report of an idea you already keep:** merge it into the kept line, then vote `+1`. `nb-ideas merge dead@my-app <kept-id> <new-id> "<kept text>"`, then `nb-ideas vote dead@my-app <id> +1`. The merged line keeps the higher score, so the score counts independent reports. Run `nb-ideas show dead@my-app` to read the id of the merged line.
      - **A plausible idea with one report** (it passes a quick check, but only one task raised it): `nb-ideas vote <shelf> <id> +1` to keep it, and do not promote it yet. It then outlives the fresh, unread lines.
      - **An idea that fails a quick check against the code:** `nb-ideas rm <shelf> <id> --reason wrong` (or `--reason obsolete` if the code has changed since).
   3. Promote any idea that two or more tasks reported. Check it against the code by its category. `dead`: a search finds no use outside its own tests. `duplicate`: both copies exist. `fragile`: reproduce it. `guidance`: the quoted text is still there. `unused`: find usage evidence, then a human decides. `overbuilt` and `tangled`: these usually need a design first. `tests`: run the test, or check what a mutation does to it. Before a deletion, check that a test covers the `keeps:` behaviour.
   4. File a work item for each idea that passes. Then remove the line, keeping the link: `nb-ideas rm <shelf> <id> --reason other --note "promoted: <link>"`.
   5. Write four counts in each work item or run note: lines read, reports merged, ideas kept, ideas promoted.

   The curator does not need `NB_SESSION`; it is the add, not the vote, that carries the task.

   Lines that nobody repeats and nobody votes for age out. That is the cap doing its normal job. A repeat that arrives after its first report has aged out is lost: the weekly run, or the 40-line rule, keeps that rare.

   The reasons, the category table and the rule for stopping the trial are in the [two use cases page](https://github.com/jeanibarz/agent-notebook/blob/main/docs/ideas-store.md#4-the-curator-recipe).

## 4. Path C: both

Do section 2, then section 3. Then note these points.

- There is one Stop hook, `nb-retrospective.sh`. It sends the lessons retrospective and, with `NB_RETRO_EXTRA_PROMPT` set, the ideas question in the same nudge. Do not register a second hook.
- The two folders must differ. Never point `NB_DIR` at the ideas folder for lessons. Check: `nb path` and `nb-ideas path` print two different folders.
- The sentinel `.retro-<session>` is written in the lessons folder.
- The whole `.claude/settings.json` for path C, with the hooks in `~/.agent-notebook/hooks` (replace `<home>` with the home folder):

  ```json
  {
    "env": {
      "NB_RETRO_EXTRA_PROMPT": "<home>/.agent-notebook/hooks/ideas-end-prompt.txt"
    },
    "hooks": {
      "SessionStart": [{ "hooks": [{ "type": "command", "command": "<home>/.agent-notebook/hooks/nb-session-start.sh" }] }],
      "SubagentStart": [{ "hooks": [{ "type": "command", "command": "<home>/.agent-notebook/hooks/nb-subagent-start.sh" }] }],
      "Stop": [{ "hooks": [{ "type": "command", "command": "<home>/.agent-notebook/hooks/nb-retrospective.sh" }] }]
    }
  }
  ```

## 5. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `nb-ideas: command not found` (or `not found` from `sh -c`) | `~/.local/bin` is not on the `PATH` of that shell, or the shim was not written | Run `ls ~/.local/bin/nb-ideas`. Add `export PATH="$HOME/.local/bin:$PATH"` where the agent's shell reads it, and re-run `sh -c 'command -v nb-ideas'`. Re-run step 2 of section 3. |
| The shim runs but prints `nb: not found` | `nb` is not on the `PATH` the shim sees | Run `sh -c 'command -v nb'`. Fix `PATH`, or use the full path to `nb` in the shim. |
| `nb add: lesson too long: 246 chars, 46 over the 200 limit` on an ideas add | `.nb.json` is missing, or this `nb` ignores it and the shim lacks `NB_MAX_CHARS=400` | Redo steps 1 and 3 (step 3 shows which case you are in). Nothing was stored, and nothing was lost. |
| `nb doctor` reports `lesson-too-long ... lesson is 374 chars; cap is 200` on the ideas folder | This `nb` ignores `.nb.json` (step 3 showed `(default)`), so plain `nb` uses 200 there | Run `nb-ideas doctor` instead; once `nb` reads `.nb.json`, plain `nb` gets it right too. |
| `nb` prints a warning that names `.nb.json` | The file is not valid JSON, is unreadable, or has an unknown key | Fix the file. `nb` ignores the bad part and goes on. A value outside 20–2000 is clamped. |
| An idea shows up in a lessons shelf | An agent ran `nb add` because `nb-ideas` was not found | Fix the shim and `PATH`. Move the line with `nb rm` on the lessons shelf and `nb-ideas add`. |
| `$(npm root -g)/agent-notebook/...: No such file or directory` | `npm root -g` prints a different folder from where the package is (a custom prefix, or npm masking part of the path) | Print the right folder with `dirname "$(dirname "$(dirname "$(readlink -f "$(command -v nb)")")")"` (it holds `agent-notebook/`) and use it wherever `$(npm root -g)` appears. |
| The Stop hook prints nothing, so the agent is never asked | The sentinel `.retro-<session id>` already exists in the lessons folder (the hook asks once per session), or `nb enabled` prints `off` | Run `ls -A "$(nb path)"` and delete that file to test again. Run `nb enabled`: if it prints `off`, run `git config nb.enabled true` in the repository. |
| The nudge has the lessons text but no ideas text | The prompt file is missing or relative (the hook prints `nb retro: ignoring NB_RETRO_EXTRA_PROMPT (...)` on stderr), or `cwd` is not a git directory, or the payload has no `session_id` | Fix the path (absolute), or run the hook from a git `cwd`, or set `NB_PROJECT_SLUG` for the project. |
| Two repositories write to the same shelves | They have no remote and their folders have the same name (`nb project` prints the same name in both) | Set `NB_PROJECT_SLUG` in each project's `.claude/settings.json`, not at user level. |
