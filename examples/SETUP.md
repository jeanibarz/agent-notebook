# Set up agent-notebook

This guide is for an AI coding agent. A user said "set up agent-notebook". Follow the steps in order. Run each command. After each step, run its "Check:" line and compare the output. If a check fails, go to [Troubleshooting](#5-troubleshooting) and do not go on.

Every command is for macOS, Linux, WSL or Git Bash. Run the commands in the user's project directory unless a step says otherwise. The sample outputs use `my-app` as the project name and `<dir>` for a folder path. Your output will differ in those parts only.

Background, when you need it: [README](https://github.com/jeanibarz/agent-notebook), [ideas store](https://github.com/jeanibarz/agent-notebook/blob/main/docs/ideas-store.md), [harness setup](https://github.com/jeanibarz/agent-notebook/blob/main/docs/harness-setup.md).

## 0. Pick a path

Ask the user which path they want. If they did not say, use A.

- **A. Lessons only.** Agents read the notebooks at the start of a task and vote on what helped at the end. Each lesson is one line of 200 characters at most. The notebook is bounded: the lowest score leaves first.
- **B. Ideas only.** At the end of a task, an agent records at most one simplification idea, and only when the task showed something to delete, merge, shorten, split, correct or make fail loudly. Most tasks record nothing. Ideas are never shown at the start of a task. A curator promotes the well-supported ones to work items.
- **C. Both.** Do path A, then path B, then read [section 4](#4-path-c-both).

Everyone does section 1. Then do section 2 (A), section 3 (B), or both (C).

## 1. Prerequisites and install

1. Check that Node.js is version 18 or newer.

   ```sh
   node --version
   ```

   Check: the output is `v18.0.0` or higher, for example `v22.11.0`. If not, ask the user to install Node 18+ and stop.

2. Install the package. It provides the `nb` command and ships the scripts used below.

   ```sh
   npm install -g agent-notebook
   ```

   Check: `nb --version` prints `nb (agent-notebook) ` followed by a version number, for example `nb (agent-notebook) 0.11.1`.

3. Check that the shipped files are where this guide says.

   ```sh
   ls "$(npm root -g)/agent-notebook/examples"
   ```

   Check: the list includes `hooks`, `ideas` and `SETUP.md`. If `npm root -g` points at the wrong place (for example you installed with a custom prefix), use the folder that holds `agent-notebook/` wherever `$(npm root -g)` appears below.

## 2. Path A: lessons

Lessons use the default folder, `~/.agent-notebook/notebooks`. Set `NB_DIR` to use another folder. The default 200-character cap stays as it is.

1. Find the lessons folder.

   ```sh
   nb path
   ```

   Check: it prints the folder, for example `<home>/.agent-notebook/notebooks`. Run `nb list` too: on a fresh machine it prints `no notebooks yet — add one with `nb add <shelf> "<lesson>"``.

2. (Optional) Create a first shelf and say when to open it. A shelf is a notebook name: short, no spaces. The description appears in the index that agents read.

   ```sh
   nb add my-app "run the formatter before the tests; CI fails on style first"
   nb describe my-app "open when working in my-app: build, test and CI gotchas"
   ```

   Check: `nb list` prints one line, `  my-app  1  open when working in my-app: build, test and CI gotchas`.

3. Give the agent the standing instruction. Run the command for the user's harness, in the project. If `CLAUDE.md` is a link to `AGENTS.md`, run only one. Each command skips a file that already has the block.

   Claude Code reads `CLAUDE.md`:

   ```sh
   grep -qs '^## Memory: agent-notebook' CLAUDE.md || sed '/^<!--/,/^-->/d' "$(npm root -g)/agent-notebook/examples/hooks/codex-cli/AGENTS.snippet.md" >> CLAUDE.md
   ```

   Codex CLI reads `AGENTS.md` (in the project, or `~/.codex/AGENTS.md` for every project):

   ```sh
   grep -qs '^## Memory: agent-notebook' AGENTS.md || sed '/^<!--/,/^-->/d' "$(npm root -g)/agent-notebook/examples/hooks/codex-cli/AGENTS.snippet.md" >> AGENTS.md
   ```

   Check (use the file you wrote to): `grep -n '^## Memory' CLAUDE.md` prints `2:## Memory: agent-notebook (`nb`)`. The line number can differ. Running the command a second time must not add a second block: `grep -c '^## Memory' CLAUDE.md` prints `1`.

4. (Optional, Claude Code only.) Add the hooks. They inject the notebook index at session start, hand it to each subagent, and ask for the retrospective at the first stop. Skip this step for Codex CLI.

   Copy the scripts somewhere stable.

   ```sh
   mkdir -p ~/.agent-notebook/hooks
   cp "$(npm root -g)/agent-notebook/examples/hooks/claude-code/"nb-*.sh ~/.agent-notebook/hooks/
   chmod +x ~/.agent-notebook/hooks/*.sh
   ```

   Check: `ls ~/.agent-notebook/hooks` lists `nb-ideas-stop.sh`, `nb-retrospective.sh`, `nb-session-start.sh` and `nb-subagent-start.sh`.

   Print the hooks block with your paths filled in.

   ```sh
   sed -e '/^  "\/\//d' -e "s|/ABSOLUTE/PATH/examples/hooks/claude-code|$HOME/.agent-notebook/hooks|" "$(npm root -g)/agent-notebook/examples/hooks/claude-code/settings.json"
   ```

   Check: it prints JSON that starts `{` / `"hooks": {` and has `SessionStart`, `SubagentStart` and `Stop`, each with a `command` that ends in one of the copied scripts and starts with the user's home folder.

   Merge the `hooks` block into `.claude/settings.json` (this project) or `~/.claude/settings.json` (every project). If the file already has a `hooks` key, add these entries to its arrays instead of replacing them. Then restart Claude Code: hooks load at startup. Do not edit the user's settings file without telling them.

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

## 3. Path B: ideas

Ideas live in a separate folder, `~/.agent-notebook/ideas`. Set `NB_IDEAS_DIR` to use another folder. They are kept apart from lessons for three reasons:

- The session-start index, `nb stats` and the janitor read the lessons folder. A mixed folder would show ideas to every agent at the start of every task.
- `NB_MAX_CHARS` and `NB_MAX_LINES` apply to a whole folder. Lessons keep 200 characters. The `nb-ideas` wrapper gives the ideas folder 400 characters and 50 lines per shelf.
- A separate folder lets a curator read ideas without touching lessons.

1. Install the `nb-ideas` command. It is a two-line shim that runs the script shipped in the package.

   ```sh
   mkdir -p ~/.local/bin
   printf '#!/bin/sh\nexec node "%s" "$@"\n' "$(npm root -g)/agent-notebook/examples/ideas/nb-ideas.mjs" > ~/.local/bin/nb-ideas
   chmod +x ~/.local/bin/nb-ideas
   ```

   `~/.local/bin` must be on `PATH`. If it is not, add `export PATH="$HOME/.local/bin:$PATH"` to the shell profile and open a new shell.

   Check: `command -v nb-ideas` prints `<home>/.local/bin/nb-ideas`.

2. Check the command works.

   ```sh
   nb-ideas help
   ```

   Check: the first line is `nb-ideas: a separate notebooks folder for improvement ideas, with rules.` The usage lists `add`, `vote`, `show`, `support`, `prompt` and `categories`.

   ```sh
   nb-ideas categories
   ```

   Check: eight lines, in this order, each `name: definition`: `guidance`, `dead`, `duplicate`, `overbuilt`, `tangled`, `unused`, `fragile`, `tests`. When two fit, an agent takes the first. The line for `dead` is `dead: code, flag, file, script or config that nothing uses: delete it`.

3. (Optional) Use your own categories. Write `categories.txt` in the ideas folder: one `name: definition` per line, names of `a-z`, `0-9` and `-` only, `#` for comments. The order is the tie-break order. Skip this step to keep the defaults.

   ```sh
   mkdir -p ~/.agent-notebook/ideas
   printf '# my categories\nguidance: a doc is wrong\ndead: nothing uses it\n' > ~/.agent-notebook/ideas/categories.txt
   ```

   Check: `nb-ideas categories` prints exactly the two lines you wrote, `guidance: a doc is wrong` and `dead: nothing uses it`. Delete the file to go back to the defaults.

4. Know the project and the shelves. The project slug is the name of the git top-level folder, lower-cased, with characters outside `a-z0-9._-` replaced by `-`. Set `NB_IDEAS_PROJECT=<slug>` or pass `--project <slug>` to override. Outside a git repository, with neither, the command exits 2. A shelf is named `<category>@<project>`, for example `dead@my-app`. A shelf is created, and given its category definition as description, the first time an idea is added to it. There is nothing to create by hand.

   Check, in a git repository: `nb-ideas prompt | head -1` starts `Before you finish: did this task show that something in my-app should be deleted`, with your project name where `my-app` is. After the smoke test in step 5, `nb-ideas list` shows one line per shelf, for example `  dead@my-app  1  code, flag, file, script or config that nothing uses: delete it`.

5. Smoke test, in a throwaway folder. Run it inside a git repository. It uses a temporary `NB_IDEAS_DIR`, so the real ideas folder stays empty.

   ```sh
   export NB_IDEAS_DIR=$(mktemp -d)
   nb-ideas add dead "scripts/old-deploy.sh: nothing calls it since CI moved -> delete the file (keeps: npm run deploy works)"
   ```

   Check: it prints `added <id> to dead@my-app`, where `<id>` is six hex characters such as `d6fb02`. (Without `NB_SESSION` it first prints a `note:` line on stderr that per-task rules are not checked. That is expected here.) Exit code 0.

   ```sh
   nb-ideas add dead "scripts/old-deploy.sh: unused deploy script -> remove it (keeps: npm run deploy works)"; echo "exit $?"
   ```

   Check: it prints `Not recorded: similar ideas already exist.`, one row with the id, `similarity 0.46, same target` and the old text, then the two ways forward, and the last line is `exit 3`. Nothing was recorded.

   ```sh
   ID=$(nb-ideas show --json | node -pe 'JSON.parse(require("fs").readFileSync(0))[0].id')
   nb-ideas vote dead "$ID" +1 --because "found it while fixing the deploy docs"
   ```

   Check: it prints `voted +1 on dead@my-app <id>: score is now 2`. A `+1` without `--because` is refused with exit 2.

   ```sh
   nb-ideas support
   ```

   Check: the first line is `promotable = score >= 3 and supporting tasks >= 2`. The row for the idea starts with `-` (not yet promotable) and shows `[2]  tasks 2 (2 unattributed)`: without `NB_SESSION`, each event counts as its own task.

   ```sh
   nb-ideas rm dead@my-app "$ID" --reason other --note "promoted: https://example.com/issues/1"
   nb-ideas show
   unset NB_IDEAS_DIR
   ```

   Check: `rm` prints `removed — [+2] scripts/old-deploy.sh: ...`, and `show` prints `no ideas recorded for my-app`.

6. Ask for an idea at the end of every task. Choose by harness.

   **Claude Code:** register the Stop hook `nb-ideas-stop.sh`. Copy it and make it executable. (If you did step 4 of path A, it is already copied.)

   ```sh
   mkdir -p ~/.agent-notebook/hooks
   cp "$(npm root -g)/agent-notebook/examples/hooks/claude-code/nb-ideas-stop.sh" ~/.agent-notebook/hooks/
   chmod +x ~/.agent-notebook/hooks/nb-ideas-stop.sh
   ```

   Print the hooks block with your paths filled in.

   ```sh
   sed -e '/^  "\/\//d' -e "s|/ABSOLUTE/PATH/examples/hooks/claude-code|$HOME/.agent-notebook/hooks|" "$(npm root -g)/agent-notebook/examples/hooks/claude-code/settings.ideas.json"
   ```

   Check: it prints JSON with one `Stop` entry whose `command` is `<home>/.agent-notebook/hooks/nb-ideas-stop.sh`.

   Merge it under `"Stop"` in `.claude/settings.json` or `~/.claude/settings.json`: add the entry to the existing `Stop` array, do not replace it. Then restart Claude Code. The hook runs `nb-ideas`, so `nb-ideas` must be on the `PATH` Claude Code starts with. If it cannot be, set `NB_IDEAS_BIN` to the full path of the shim.

   Verify by sending a Stop payload to the hook. Use a git repository for `cwd`, and a temporary folder for the sentinel.

   ```sh
   T=$(mktemp -d)
   echo '{"session_id":"test-1","hook_event_name":"Stop","cwd":"'"$PWD"'"}' | NB_IDEAS_DIR=$T ~/.agent-notebook/hooks/nb-ideas-stop.sh
   ```

   Check: it prints one JSON line that starts `{"decision":"block","reason":"Before you finish: did this task show that something in my-app should be deleted, merged, shortened, split,`. The reason ends with the `nb-ideas vote` form and `or re-run the add with --new if yours is different.` Run the same command again with the same `T`: it prints nothing, because the sentinel `.ideas-prompt-test-1` now exists in `T`.

   **Codex CLI and other harnesses:** they have no Stop hook. Append an instruction to `AGENTS.md` (or the harness's instruction file) that tells the agent to run `nb-ideas prompt` at the end of a task. The command prints the current prompt, with the project name filled in, so the instruction never goes stale. The `grep` skips a file that already has it.

   ```sh
   grep -qs '^## Ideas: end of task' AGENTS.md || printf '\n## Ideas: end of task\n\nBefore you finish a task, run `nb-ideas prompt` and follow what it prints. Most tasks have nothing to record; then just stop.\n' >> AGENTS.md
   ```

   Check: `grep -c '^## Ideas: end of task' AGENTS.md` prints `1`, also after a second run. `nb-ideas prompt` in the project prints the prompt: it starts `Before you finish:` and contains `nb-ideas add <category>`.

7. (Optional) Set `NB_SESSION`. `nb-ideas` enforces three per-task rules when it knows the task id: one `add` per task, one vote per idea per task, and no `+1` on an idea the same task added. It also counts support per distinct task. The Claude Code hook gives it the id for free: it prints the commands in its prompt with `NB_SESSION=<session id> ` in front, so the agent runs them with the id set. A harness that has its own per-task id can export `NB_SESSION` before the agent runs. Without an id the rules are not checked: every event counts as its own task, and `nb-ideas` prints a `note:` line on stderr saying so.

   Check: `NB_SESSION=task-42 nb-ideas prompt --session task-42 | grep -c 'NB_SESSION=task-42 nb-ideas'` prints `2`. A second `add` by the same session in the same project is refused with exit 2 and `this task already recorded idea <id> (<shelf>); vote instead:`.

8. Hand the curator recipe to the user. Once a week, a person or an agent does this for each project:

   1. `nb-ideas support --project <slug>` lists the ideas. Look at the rows that start with `PROMOTABLE` (score at least 3, from at least 2 distinct tasks).
   2. Check each one against the code, by category. `dead`: search finds no use outside its own tests. `duplicate`: both copies exist. `fragile`: reproduce it. `guidance`: the quoted text is still there. `unused`: a human decides. Before a deletion, check that a test covers the `keeps:` behaviour.
   3. File a work item for each idea that passes.
   4. `nb-ideas rm <shelf> <id> --reason other --note "promoted: <link>"` removes the idea. For one that fails the check, use `--reason wrong` or `--reason obsolete`.

   The full recipe is in `$(npm root -g)/agent-notebook/examples/ideas/README.md`.

## 4. Path C: both

Do section 2, then section 3. Then note these points.

- Both Stop hooks block the same first stop. Claude Code gives the agent both reasons together at that stop (verified on Claude Code 2.1.330). The agent handles the lessons retrospective and the ideas question in one pass, then stops.
- Each hook has its own sentinel in its own folder (`.retro-<session>` in the lessons folder, `.ideas-prompt-<session>` in the ideas folder), so neither can loop or use up the other's ask.
- The two folders must differ. Never set `NB_IDEAS_DIR` to the same folder as `NB_DIR`. Check: `nb path` and `nb-ideas path` print two different folders.
- Register both hooks under one `Stop` array: `nb-retrospective.sh` and `nb-ideas-stop.sh`.

## 5. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `nb-ideas: command not found` | `~/.local/bin` is not on `PATH`, or the shim was not written | Run `ls ~/.local/bin/nb-ideas`. Add `export PATH="$HOME/.local/bin:$PATH"` to the shell profile and open a new shell. Re-run step 1 of section 3. |
| `nb-ideas: cannot find the agent-notebook package (looked beside ... and in the global npm root)` | `agent-notebook` is not installed globally, or the shim points at a script that was copied out of the package | Run `npm install -g agent-notebook`. Re-create the shim from `$(npm root -g)/agent-notebook/examples/ideas/nb-ideas.mjs`. |
| `cannot tell which project this is: run inside a git repository, or pass --project <slug> (or set NB_IDEAS_PROJECT)` (exit 2) | The working directory is not in a git repository | Run from inside the repository, or `export NB_IDEAS_PROJECT=<slug>`, or add `--project <slug>`. |
| `nb doctor` reports `lesson-too-long  <shelf>:<n>  lesson is 350 chars; cap is 200` on the ideas folder | Plain `nb doctor` checks with the 200-character lessons cap, and ideas may be 400 | Run `nb-ideas doctor`. It uses the ideas caps and prints `nb doctor: OK — 1 shelf checked, no problems found`. |
| The Stop hook prints nothing, so the agent is never asked | The sentinel for that session id already exists (the hook asks once per session), or `nb enabled` prints `off` for the repository | Run `ls -A "${NB_IDEAS_DIR:-$HOME/.agent-notebook/ideas}"` and delete `.ideas-prompt-<session id>` to test again. Run `nb enabled`: if it prints `off`, run `git config nb.enabled true` in the repository. Also run `nb-ideas prompt` yourself: if it fails, the hook lets the stop through. |
| `nb-ideas add` exits 3 and records nothing | A similar idea or one with the same target exists | Vote for it: `nb-ideas vote <shelf> <id> +1 --because "<what in this task hit it>"`. If yours is different, run the same `add` again with `--new`. |
| `this task already recorded idea <id> (<shelf>); vote instead` (exit 2) | `NB_SESSION` is set and this task already added one idea in this project | Use `nb-ideas vote` for further ideas. The limit is one `add` per task. |
| `unknown category "x". Categories (first that fits): ...` (exit 2) | The category is not in the list, or `categories.txt` replaced the defaults | Run `nb-ideas categories` and use one of those names. |
