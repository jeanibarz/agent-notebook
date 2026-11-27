# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Version headings are bracketed and linked once a release is tagged; untagged
versions are listed plainly.

## [Unreleased]

- **Development runs stay out of the real notebook.** `AGENTS.md` (section 6) now says to try a build by hand with `HOME="$(mktemp -d)" NB_DIR="$(mktemp -d)" node dist/cli.js …`, and the plugin end-to-end scripts (`scripts/plugin-e2e/run.sh`, `run.ps1`) drop every inherited `NB_*` variable before they start. On a machine where agent sessions export `NB_DIR`, one local run of the end-to-end script had written 12 `brief` rows of its test versions into the real usage log, and unreleased commands tried through the released `nb` on `PATH` had added 9 unknown-command errors, which `nb stats` reported as a high-error-rate anomaly. No code in the package changes.
- **The Claude Code plugin zip now carries `CHANGELOG.md`**, so `nb status` run from the plugin shows the release date (issue #560, first part).
- **`nb place default [shared|own|ask]` says, or records, where the notes of every project are kept (issue #560, second part).** With no value it only reads (`--json` prints `{"default","source"}`). `own` gives each project its own notebook; `shared` (the default when nothing was chosen) keeps one notebook in sections per project; `ask` is recorded for the next part. The answer is one word in `~/.agent-notebook/projects/.layout`, written only by this command. It never moves a note.
- **A chat that starts in a project follows the answer `own` (issue #560).** `nb brief` gives a project named from its git remote an empty own folder, once, unless the shared notebook already holds notes for it (then nothing moves). A name set with `NB_PROJECT_SLUG` never gets a folder this way, and `nb place own|shared` now mark the project as settled.
- **`nb place`, `nb status` and `nb config` say where notes are kept** and since when, only when a choice was made and `NB_DIR` is not set; with no choice every output is unchanged. Once a choice exists, the start-of-chat index is grouped by project from the first chat. `default` can no longer be the name of a project notebook.
- **The first chat after installing the plugin says the notebook is on and asks one question: where notes are kept (issue #560, third part).** It is a short set-up note that `nb brief --welcome` puts first in the start-of-chat text; the plugin's hook adds the flag on a fresh start only. The choices are one notebook for all projects (recommended, already in effect), a separate notebook for each project, or ask in each new project. A new project gets its own question only when the answer was "ask", and never if the shared notebook already holds notes for it. The note is printed once: the first chat records a claim in `~/.agent-notebook/projects/.first-start` and a later `nb retro` for that chat confirms it, so a chat that is opened and closed without a prompt does not use it up.
- **In the chat that asks the question, the end-of-task notes wait until the user has answered (issue #560).** The Stop right after the first reply only records that the question was shown (`nb retro` outcome `deferred`, nothing printed); the chat's next Stop asks for the retrospective as usual. A first chat with a single reply therefore ends without one. Before this, a lesson written at that first Stop landed in the shared notebook, so the answer "a separate notebook for each project" could not give the current project its own.
- **Nothing changes for existing users.** Whoever has `NB_DIR` or `NB_PROJECT_SLUG` set, any shelf, a git folder or `.nb.json` in the notebook, a messages folder or a project folder never sees the note, and `nb place default shared` beforehand means the question is never asked. Without `--welcome` every output of `nb brief` is byte for byte what it was.
- **The plugin's hook adapter reads one file of yours, once per fresh chat:** your Claude Code `settings.json`, only to look for the names of hooks copied by hand (`nb-claude-hook`, `nb-session-start`, `nb-retrospective`, `nb-hook-entry`) and then withhold the note. Nothing in it is parsed, printed or passed on, and a network path in `CLAUDE_CONFIG_DIR` is refused unopened. Details: `docs/enterprise.md`.
- **The plugin's could-not-load line is plainer:** `reinstall agent-notebook` when the program is missing or too old, `took too long to start; it will try again next chat` after 15 seconds. Outside the plugin the text is unchanged. The plugin's skill now lists the start-of-chat notes it trusts and says how to change where notes are kept.
- **A usage log that is not a plain file can no longer hang, bloat or fail a call (issue #576).** With a FIFO, a link to `/dev/zero`, a folder or a 3 GB file at `.nb-usage.log`, `nb brief`, `nb list`, `nb stats` and every other command used to hang, grow to gigabytes or exit 1. Now every usage file (the log, its `.count` sidecar and the new `.nb-usage.log.1`) is opened without blocking and used only when it is a regular file, and every read is capped (`NB_USAGE_RING` × 1 KiB, at least 1 MiB). A call whose row cannot be written for that reason prints one line on stderr saying which file and that the lessons are not in it; its output and exit code do not change. A read-only notebook folder stays silent, as before. `nb status` applies the same rule and says in plain words that the log is a link, a folder or a special file. A `.count` sidecar planted as a link no longer overwrites what it points to.
- **The usage ring no longer loses rows written during a burst (issue #576).** It used to compact by rewriting the log, which dropped rows written meanwhile: 154 of 5,000 rows in 100 bursts of 50 parallel calls, so `nb status` could miss a chat start. The ring is now two files: when `.nb-usage.log` fills, one call renames it to `.nb-usage.log.1` under a try-once lock (no call waits), and a row written meanwhile lands in a file that is still read. The same bursts lost no row. The few cases where a row can still be lost are listed in FR-USAGE-005.
- **Behavior change (issue #576).** A usage log that is a symbolic link is refused, not followed (the old compaction replaced such a link with a plain file anyway); a linked `NB_DIR` still works. The disk now holds up to two generations of the ring (about 2 × `NB_USAGE_RING` rows); delete `.nb-usage.log*` to purge it. An older `nb` sharing the folder reads only the live file, and an older `nb place shared` sees `.nb-usage.log.1` as a foreign file. The `.gitignore` the git wrapper and the backup script write (`.nb-usage.log*`) already covers the new file; one that lists the log by its full name does not. `examples/nb-janitor.mjs` reads both files. For library callers, `parseUsage` now returns at most `NB_USAGE_RING` rows read from both files, gives no rows (and never throws) for a link, a folder or a FIFO, and reads at most `NB_USAGE_RING` × 1 KiB; `logUsage` may now create `.nb.lock` for a moment and `.nb-usage.log.1`.

## [0.13.0-beta.2] - 2026-11-27

**TL;DR.** The second beta of epic #537, and the first release that carries the Claude Code plugin (#559) as a zip on its GitHub release.
- **npm:** a plain `npm install agent-notebook` still gives 0.12.0. Try this beta with `npm install -g agent-notebook@beta`.
- **The plugin** is not installable with one command yet: the marketplace file that names this zip is added by a later pull request, which the owner merges.
- **Also new since beta.1:** your own start and end messages (#539), the fixes to `nb place` (#551), `nb status`, which says in plain words whether chats start the notebook here (#558; usage rows gain a hook label and the `version` and `project` columns), the old-Node hook entry and the docs for company machines (#559), and the Codex CLI hooks docs (#561).

### Added

- **`nb status` says whether chats start the notebook here (issue #558, third part).** Two plain lines (what is the case, what to do next), then the details; `--json` prints the same as fields, with no path and an `announce` flag. The verdicts are `running`, `not_seen`, `off`, `place_unknown` and `broken`; it exits 0 only for `running`. It reads the usage rows `nb brief --hook` and `nb retro --hook` write, plus a few live checks, and writes nothing (not even a usage row), takes no lock and creates no folder. `running` claims only that the start step ran, not that the assistant used the list. `docs/harness-setup.md` gains "When nb status has not seen a chat", and the `nb stats` line "injection hook not wired" points to it.
- **Documentation for company machines and for moving to the plugin, and the check on the marketplace file (issue #559, fifth part).** `docs/enterprise.md` has a new section, "Claude Code plugin": what the plugin runs at session start and what it reads, writes and sends (nothing), how to allow it with `strictKnownMarketplaces`, how to run it under `allowManagedHooksOnly: true` from an administrator-owned copy with the `--managed` block, how to rebuild a release from its tag, and what an update changes. `docs/harness-setup.md` gains "Moving to the plugin" for people with hand-copied hooks. A new `marketplace-check` workflow and `scripts/check-marketplace.mjs` check, on a pull request that changes `.claude-plugin/marketplace.json`, that the release exists and its zip matches the file's sha256, the versions inside it and a rebuild of the tag, and then install it on three systems.
- **Each GitHub release now carries the Claude Code plugin zip (issue #559, fourth part).** The release workflow builds `agent-notebook-plugin-<version>.zip` and checks that the tag, `package.json`, `package-lock.json` and the zip agree on the version, publishes to npm as before, then attaches the zip, its sha256 and `SHA256SUMS` to the GitHub release, after proving the zip matches the npm package and the tagged commit. `node scripts/check-release.mjs --pr` runs in CI on every pull request. `docs/releasing.md` describes the order of a release, re-runs, rollback and the repository settings the owner should make.
- **The Claude Code plugin's files and a reproducible build of its zip (issue #559, second part).** `plugin/` holds the plugin's manifest, `hooks/hooks.json` (the hook entry for each event, plus two commands that print one notice when Node.js is missing), the `agent-notebook` skill and the `bin/nb` launcher; `node scripts/build-plugin.mjs` builds `build/plugin/agent-notebook-plugin-<version>.zip` (and a staged folder for `claude --plugin-dir`) with its checksum. The same inputs give the same bytes on any machine. The zip holds the package's `dist/` and no dependency; `plugin/` and `scripts/` are not part of the npm package. The release job attaches the zip to each GitHub release from 0.13.0-beta.2 on.
- **A hook entry that an old Node.js can still read (issue #559, first part).** `examples/hooks/claude-code/nb-hook-entry.cjs` is what the coming Claude Code plugin's hooks run first. With a Node.js older than 18 it tells the assistant, at session start, that the notebook needs Node.js 18 or later and where to get it, instead of the adapter crashing in silence (Node 10 and 12) or running on a version the package does not support (Node 14 and 16); for other events it stays quiet. With Node.js 18 or later it hands over to `nb-claude-hook.mjs`, whose output is unchanged. `--managed` makes it ignore `NB_BIN`, for administrators' hook blocks. `print-settings` and the `.sh` hooks are unchanged.
- **A harness label for the example hook adapter (issue #558).** `nb-claude-hook.mjs` takes `--harness <name>` and records each run as `<name>.<event>` in the usage log (the Codex docs now use `--harness codex`); without the flag it says `claude-code` only when Claude Code's own session id matches the payload's, and `hook` otherwise. Codex hooks pasted before this change are recorded as `hook.*`, or as `claude-code.*` by an older adapter.
- **The usage row records that a hook ran (issue #558, second part).** `nb brief` and `nb retro` rows gain two trailing columns, `version` (the `nb` version) and `project` (the project name, or `h:` and 12 hex characters of a hash of its folder, or `?`; written only when `--hook` is given). Every other row is unchanged and old rows read as before. The exported `UsageRow` type gains `version: string` and `project: string` (both `''` on a row without them), an additive change, and `parseUsage(dir, { maxBytes })` reads only the tail of a log that is a regular file, so a FIFO or a link to a device cannot hang it. Nothing is written outside `NB_DIR`. The requirement text for `nb status` lands with it, marked proposed.
- **Your own words in the start-of-session text (issue #539, first part).** Put plain UTF-8 text in `~/.agent-notebook/messages/brief.txt` and `nb brief` shows it to the assistant after the built-in text, framed as the user's own instructions; `<project>.brief.txt` (the name `nb project` prints, from `NB_PROJECT_SLUG` or the git remote) is added after it for one project and wins where the two differ. Each file holds at most 1,000 characters after cleaning; a file that cannot be used (too long, not UTF-8, not a regular file, ...) gives one warning line in the brief instead of being skipped silently. The folder is never created or written by `nb`, is not read when the home folder is empty or relative, and is refused when it lies inside `NB_DIR`. `nb config` shows which files are in force, but only once `~/.agent-notebook/messages/` exists (or the home folder is not absolute); without it every output is unchanged. Hooks copied from 0.12 never call `nb brief`, so they ignore these files.
- **Your own words in the end-of-task text (issue #539, second part).** `~/.agent-notebook/messages/retro.txt`, then `<project>.retro.txt`, are added to what `nb retro` says, after the built-in text and before the `NB_RETRO_EXTRA_PROMPT` text, which works exactly as before (no label, same warnings). The same framing, warning line and rules as for `nb brief` apply; each retro file holds at most 4,000 characters. The files are read only when `nb retro` speaks, never for a repeated stop or where the switch is off. `{project}` (the name `nb project` prints, asked in `--work-dir`, else the working directory) and `{session}` are filled in these files; a block that uses a placeholder with no value (no project name, or `--session ""`) is left out without a warning. `nb config` gains the `retro.global`, `retro.project` and `retro.env` rows (the last shows the `NB_RETRO_EXTRA_PROMPT` file and says when the nudge would carry the same text twice), and `--json` gains `messages.retro`; both still appear only once `~/.agent-notebook/messages/` exists. Hooks copied from 0.12 never call `nb retro`, so they ignore these files too.

### Fixed

- **A command never re-creates a project's own notebook that `nb place shared` removed while it ran (issue #551).** The lock used to check that the folder existed and then create it, so a removal in between brought back an empty folder, and the usage log re-created it too. Now the folder is never created by such a call, through the lock or the usage log: the write refuses (exit 1, `place_unknown`, as before) with a message saying the notebook was moved back to the shared notebook, that nothing is lost, and to run the same command again; the usage row goes to the shared notebook's log. With `NB_DIR` set, or without a `projects/` folder, nothing changes. Library callers of `withLock` and `logUsage` keep creating the folder as before.

- **`nb place own` and `nb place shared` no longer race other writers (issue #551).** Both now take two locks in one fixed order, the shared notebook's first, then the project folder's, and decide everything once they hold them. `nb place shared` used to link shelves into the shared notebook holding only the folder's lock, and a second `nb place own` started before the first created the folder filled it without that folder's lock; no lesson was lost, but a shelf could end up "kept". The clash and foreign-file check of `nb place shared` now runs under the locks, so a refusal always means nothing changed, and a shelf left in both places by a run that stopped halfway no longer counts as a clash. If the folder's lock stays busy for half the stale threshold (5 s by default), the command stops with nothing changed and says when to run it again. A Ctrl-C while it waits releases both locks. Both commands now hold the shared notebook's lock for the whole move, so other projects' writes wait for it.

- **`nb place shared` can no longer have its folder re-filled while it empties it (issue #551).** It used to empty the project folder, release its lock and only then remove it, so a write waiting on that lock could land in the folder and keep it (`shared-partial`), after which the next run refused on a clash. Now, holding both locks, it first renames the folder away (to a hidden `.old-<project>-…` folder next to it), so the project uses the shared notebook from that moment and a waiting write refuses with the "moved back" message; then it moves the shelves out of the renamed folder and removes it. A refused rename (on Windows, a file held open in the folder) changes nothing, and so does a shelf that cannot be linked into the shared notebook (a name too long, a file system without hard links): the folder is put back. If a run stops halfway (a crash, a kill), the next `nb place shared` finishes it, `nb place` names the folder, and `nb place own` refuses until then; nb never removes a folder that still holds a shelf. Leftover staging folders are now removed only when they are real folders, never through a symbolic link (before, a link named like one had the files of its target deleted).

### Documentation

- **Setup guide and requirements catch up with the project name from the remote (issue #551).** `examples/SETUP.md`'s ideas-store check now shows the name `nb project` prints (`acme-my-app` for `git@github.com:acme/my-app.git`), not the folder name, and says the layered index also turns on with a name from the remote; FR-ENABLED-001 says `nb brief` and `nb retro` also run `git config --get remote.origin.url` for the name.
- **Codex CLI has lifecycle hooks: the docs no longer say it has none (issue #561).** The harness guide gains [Codex hooks](docs/harness-setup.md#optional-codex-hooks): a `~/.codex/hooks.json` that runs the Claude Code adapter `nb-claude-hook.mjs` under `SessionStart` and `Stop`, checked with Codex CLI 0.171.0 on Linux. It says that each hook must be one command string (Codex ignores `args`), how to trust the hooks in an interactive session, and how to see that they are off (`codex exec` skips an untrusted hook without a message). The `AGENTS.md` snippet stays the route without hooks. No Codex plugin is shipped. The Codex example README drops its `notify` section, which the `Stop` hook replaces.
- **Your own start and end text (issue #539, third part).** The hooks README has a section on `~/.agent-notebook/messages/` (file names, caps, previews, upgrading from 0.12 copies and the git wrapper); the ideas-store, setup, enterprise (backup and deny rules), getting-started, CLI and operating guides and RFC 0530 point to it.

## [0.13.0-beta.1] - 2026-11-26

**TL;DR.** A beta of the new setup core from epic #537. Try it with `npm install -g agent-notebook@beta`; a plain `npm install agent-notebook` still gives 0.12.0.

- **The notebook text comes from `nb` itself.** `nb brief` prints what an assistant sees at the start of a session, and `nb retro` asks for the end-of-task retrospective once per session. The Claude Code hooks become one small Node script that needs no bash and runs on Windows; `node <package>/examples/hooks/claude-code/nb-claude-hook.mjs print-settings` prints the block for `settings.json`. Hooks copied from 0.12 keep working.
- **No more `NB_PROJECT_SLUG` to set.** `nb project` derives the project name from the git remote (`git@github.com:acme/app.git` gives `acme-app`).
- **A project can have its own notebook.** `nb place own` creates `~/.agent-notebook/projects/<project>/` and moves that project's shelves into it; `nb place shared` moves them back. Without that folder nothing changes.
- **One thing to check:** with the new hooks and without `NB_PROJECT_SLUG`, `{project}` in `NB_RETRO_EXTRA_PROMPT` becomes `owner-repo` instead of the folder name in a repository with an `origin` remote, so new ideas-store shelves start under the new name. Set `NB_PROJECT_SLUG` to keep the old one.

The full list follows.

### Added

- **`nb brief`: what an assistant sees at the start of a session (issue #538).** It prints what the 0.12 example session-start hook printed, word for word (the instruction lines and the `nb list` index, or the layered index when `NB_PROJECT_SLUG` is set), with three differences: one new line framing the lessons as notes from earlier agent runs, not instructions from the user; a store that cannot be read is named by its error code (`EACCES`) instead of an exit status; and the cut line below. Over `--max-chars` (default 9000, under Claude Code's 10,000-character limit for hook output) the shelves with the fewest lessons are dropped and the last line says how many. Control characters and line separators in a name, description, folder path or slug are shown as `\uXXXX`, so no value can forge a line. It reads no hook payload and exits 0 in every runtime state; `--json` prints `{outcome, text}`.
- **`nb retro --session <id>`: the end-of-task retrospective text, once per session (issue #538).** It prints the text the 0.12 example Stop hook sent, word for word, the first time it is called for a session, and nothing on later calls, so a harness's stop hook can call it on every stop. It reads no hook payload and exits 0 in every runtime state. "First" is decided by creating `<NB_DIR>/.retro-<id>` exclusively, the same file the 0.12 Stop hook creates, so an old copied hook and the new command nudge once between them. `.retro-*` files older than `NB_RETRO_TTL_DAYS` (7) are then removed. It prints nothing where `nb enabled` says off, here or in `--work-dir` (the directory the assistant last worked in). `NB_RETRO_EXTRA_PROMPT` is appended as the hook does it, and must now name a regular file of at most 64 KiB, so a FIFO can no longer stall the call and a UTF-16 file is skipped with a warning instead of reaching the model as garbled text. `--json` prints `{outcome, text, session}`.
- **A Windows CI leg** runs the tests of the new commands and of the hook adapter.
- **`nb project [--why] [--json]`: the project name of this directory (issue #540).** It prints `NB_PROJECT_SLUG` when set (no git runs); otherwise the git `origin` remote's path with its segments joined by `-` and the host left out (`git@github.com:acme/app.git` gives `acme-app`); otherwise the repository's folder name; outside a repository, or when git is missing, slow or refuses the folder, an empty line. A remote URL is never printed, and a URL with a token or any unusual character in its path gives the folder name instead. `--why` says which rule decided; `--json` prints `{name, source, reason}`.
- **A project can have its own notebook: the folder `~/.agent-notebook/projects/<project>/` (issue #548).** When that folder exists, `<project>` being the name `nb project` prints from `NB_PROJECT_SLUG` or the git remote, every `nb` command run in that project reads and writes it instead of the shared notebook, with its own usage log and stats; other projects keep the shared notebook. There is no setting: the folder is the switch.
  - **Nothing changes without it.** With `NB_DIR` set, or with no `projects/` folder, every output is byte-identical and no new process is started. Once a project folder exists, each notebook command in a repository without `NB_PROJECT_SLUG` runs `git` twice (about 6 ms) to learn the name.
  - **`nb place [--json]`** says where this directory's lessons live (`own`, `shared`, `env` for `NB_DIR`, or `unknown`) and why, and lists the project folders. In an own notebook it also counts the project's shelves still in the shared notebook, and warns when other users can read the folder.
  - **`nb place own`** creates the folder (mode 0700) and moves the project's `<x>@<project>` shelves into it as whole files, so every score is kept; run again, it moves anything left. It refuses when `NB_DIR` is set or the name comes only from the repository's folder (add an origin remote, or set `NB_PROJECT_SLUG` for that project). **`nb place shared`** moves every shelf back (one without the `@<project>` suffix comes back as `<x>@<project>`, so it does not merge into a general shelf) and removes the folder; it refuses when a shelf name is already in the shared notebook or the folder holds anything else, such as a `.git`. Through the git wrapper, both commit the shelves that leave or enter the shared notebook.
  - **Never the shared notebook by accident.** A write to a shelf `<x>@<project>` of a project that has its own folder is refused from anywhere else (a plain folder, another repository, a clone named only by its folder), so a client's lessons do not land in the notebook every project reads. When nb cannot tell which notebook to use (git timed out, or refused the folder for its owner), every notebook command exits 1 with the new error class `place_unknown` and reads and writes nothing; `nb brief` says so instead of showing an index. A missing `git` is not such a case: the shared notebook keeps working.
  - **`nb brief`** adds one line only when a project folder exists: inside an own notebook, that the lessons go there and that the shared notebook's general shelves are not included; elsewhere, how many projects have their own notebook (never their names).
  - **The retrospective marker** stays in the shared notebook, so a session is asked once even when it moves between projects.
  - **The git wrapper** (`examples/nb-git-wrapper.mjs`) no longer sets `NB_DIR` when you did not, which pinned every call to the shared notebook; it commits the folder nb wrote. A copied 0.12 wrapper still sets it, so project folders are not used through it until it is copied again: `nb place` says so.
  - **Not covered:** `nb-backup.sh` and `nb-janitor.mjs` still act on `NB_DIR` or the shared notebook only.

### Changed

- **The project name is derived automatically, so the grouped index needs no `NB_PROJECT_SLUG` (issue #540).** With `NB_PROJECT_SLUG` set nothing changes: the start-of-session text, the retrospective and every `--json` output are byte-identical, and no git runs for the name. Without it, `nb brief` and `nb retro` use the name `nb project` prints:
  - **`nb brief`** groups the index into project, domain and global shelves by that name, but only when a shelf name in the store already contains `@` and the name comes from the git `origin` remote. A store with no `@` shelf, a repository without a remote and a folder outside git keep the flat index, and then `nb brief` starts no new process. For a derived name the line counting other projects' hidden shelves says "project name" instead of "slug", and the NOTE for a name with no shelf points to `nb project --why`. `nb brief --json` keeps its shape; its `outcome` can now be `layered` for such a store.
  - **`nb retro`'s `{project}`** in `NB_RETRO_EXTRA_PROMPT` becomes `owner-repo` for a repository with an `origin` remote (`my-app` becomes `acme-my-app`); without a remote it is still the folder name (a submodule now gets its own name, not `modules`). Ideas written before stay under the old name: `nb project --why` shows it, the janitor's slug-drift section lists the pair, and `nb move` folds them. To keep the old name, set `NB_PROJECT_SLUG` to it in that project's `.claude/settings.local.json`.
  - **When it starts:** at the first session after the upgrade for hooks that run `nb brief` and `nb retro` (the adapter, or `print-settings`). Copied 0.12 scripts keep the folder name until they are copied again, so two machines on different setups can write to two names.
  - **Privacy:** the remote's owner (often an employer or a client) becomes part of shelf names in the shared notebook, and `nb list --limit 1000` lists them in every project's sessions. Set `NB_PROJECT_SLUG` to choose another name.
- **The Claude Code example hooks are a thin adapter around `nb brief` and `nb retro` (issue #538).** `examples/hooks/claude-code/nb-claude-hook.mjs` reads the hook payload, skips the stops that must not nudge (as before: a repeated stop, a subagent's stop, a lead waiting for delegated work), runs `nb brief` or `nb retro`, and wraps the text in Claude Code's reply format; the hooks hold no instruction text of their own. `node nb-claude-hook.mjs print-settings` prints a hooks block that runs it with `node` and no shell, from the installed package, so it needs no copy and no bash, works on native Windows, and updates with the package. The three `.sh` files keep their names and now only run the adapter beside them, so a `settings.json` that names them needs no change; copy all four files together. What the model receives is unchanged apart from the framing line of `nb brief`, with these differences: when `nb` is missing, fails or is too old to have `nb brief`, the start hooks inject one line naming the problem (they printed nothing before), and the Stop hook sends nothing (it nudged before); a `.sh` file copied without the adapter beside it does the same at session start and prints nothing otherwise; `nb`'s own warnings reach the hook's stderr; and each hook run adds a row to the usage log. An old copied Stop script and the new hook share the `.retro-<session>` file, so a session is still nudged once between them. The 0.12 scripts are kept as test fixtures, outside the package.
- **The usage log and `nb stats` for hook commands.** A `nb retro` call that finds the session already claimed logs no usage row, so a stop hook does not add one per stop. `nb stats` no longer reports `nb retro` or `nb brief` as a loop, and does not report `enabled` or `list` as gone silent while those commands run, since the hooks no longer call them.
- **`nb config`** no longer lists `NB_RETRO_EXTRA_PROMPT`, `NB_RETRO_TTL_DAYS` or `NB_PROJECT_SLUG` as not read by `nb`.

### Documentation

- **One notebook per project (issue #548).** `docs/harness-setup.md` gains a section on `nb place own`: what it does and does not guarantee, how `NB_DIR` interacts with it, and how to version, back up and scan an own notebook (one `git init`, the backup loop over `~/.agent-notebook/projects/*/`, the janitor with `NB_DIR` set to the folder). `docs/getting-started.md` links to it.

- **Requirements for `nb brief` and `nb retro` (issue #538).** `docs/requirements.md` gains section 4.17: the two harness-blind commands that print the start-of-session text and the once-per-session retrospective, and the Node adapter for the Claude Code hooks, all implemented; a record that the hooks ran (FR-HEARTBEAT-001) is still proposed. DP-6 now lists the inputs a call may depend on, and NG-005 says it governs lessons, not runtime markers such as the retrospective sentinel. `docs/harness-setup.md`, `examples/README.md`, `docs/memory-layers.md` and RFC 0530 describe the commands.

## [0.12.0] - 2026-11-23

### Added

- **A notebooks folder can set its own line length with `.nb.json`.** A file named `.nb.json` in the notebooks folder with `{ "maxChars": 400 }` sets the characters per lesson for every `nb` command run on that folder, over `NB_MAX_CHARS`; out-of-range values clamp to 20-2000 as the variable does, and a folder without the file behaves as before. A file that is unreadable, invalid or not an object prints one `warning:` line on stderr and is ignored, and the command runs; unknown keys are named in the warning and skipped, while a valid `maxChars` beside them still applies. `nb config` shows `(.nb.json)` as the source. Library callers keep using `NB_MAX_CHARS`.

### Fixed

- **`.nb.json` review follow-ups.** A `.nb.json` that starts with a UTF-8 byte-order mark, as Windows PowerShell 5 writes it, is now read instead of rejected as invalid JSON. With `NB_GIT_SESSION_TRAILER=1`, the git wrapper's `Nb-Session:` trailer is now capped at the folder's `maxChars`, so it matches the usage log's session column again. The invalid-JSON warning keeps accented and other printable characters; only control, line-break, bidi-override and invisible characters become `?`. An integer too large to be exact, such as `1e30`, now clamps to 2000 like any other out-of-range value instead of being ignored as "not an integer".

### Documentation

- **A step-by-step setup guide, `examples/SETUP.md`, and docs for the ideas use case.** The guide is for an AI agent. It has a path for lessons, one for ideas and one for both, and each step ends with a command to run and the output to expect. It ships in the npm package. A new page, `docs/ideas-store.md` (*Two use cases: lessons and ideas*), sets the two use cases side by side, explains why ideas live in their own folder, and gives the curator recipe and how the trial will be judged. The design is the accepted RFC 0530. The README has a short section on the two use cases, and the setup skill now asks which use case the user wants.
- **`NB_RETRO_EXTRA_PROMPT` in the example Stop hook.** `examples/hooks/claude-code/nb-retrospective.sh` can append the text of a file to its nudge, with `{project}` and `{session}` filled in. `examples/hooks/ideas-end-prompt.txt` is the end-of-task ideas question that goes with it. The hooks README documents both.

## [0.11.1] - 2026-11-22

### Fixed

- **The film plays inside the README on GitHub again.** 0.11.0 wrapped it in a `<video>` tag with a poster for npm. GitHub then kept the raw attachment address as the video source instead of the signed one it uses for a bare link, and Chrome refused to load it for signed-in readers ("Media load rejected by URL safety check"). The README is back to the bare link GitHub turns into its player. The poster for npm now sits in a `<video>` tag with no source: GitHub drops that tag and everything in it, and npmjs.com, which strips the tag but keeps what is inside, shows the poster linking to the film.

## [0.11.0] - 2026-11-22

### Added

- **A 49-second film at the top of the README, with its source in `media/launch-video/`.** It shows one notebook being added to, voted on and capped. Where the page cannot play it (npmjs.com is expected to strip the player), a poster image linking to the film shows instead, and a plain link follows. The commands and output it shows come from a real run of `nb`, abridged and laid out for the screen; the failing and passing test at its start and end are an illustration. The folder is not part of the npm package.

- **`examples/hooks/claude-code/nb-subagent-start.sh`: give subagents the notebook index.** Claude Code runs `SessionStart` hooks for the main session only, so a subagent never saw the index and, unless its brief mentioned the notebooks, never opened one. The new optional `SubagentStart` hook hands each subagent the same index. It wraps `nb-session-start.sh` because a `SubagentStart` hook's plain stdout is not added to the subagent's context; only JSON `additionalContext` is. The example `settings.json` registers it.

### Changed

- **The README is restructured and under 40% of its old length; the reference moved to `docs/`.** The 0.10.0 README was 71,929 characters; npmjs.com is expected to cut a README at 65,536, which would fall inside the Programmatic use example and drop the sections after it. The README now opens with what the tool is for, the install line and a real first session, and says up front that `nb` does nothing until a harness runs it. The command walk-throughs moved to `docs/cli-reference.md`, `nb stats`, the usage log and the knobs to `docs/operating.md`, the full library example to `docs/programmatic-use.md`, the per-repository on/off recipe to `docs/harness-setup.md`, and "A full shelf is the normal state" to `docs/eviction-and-aging.md`. The Mermaid loop diagram is dropped; the task-start and task-end table beside it stays. The `cat` and `git diff` images are redrawn from real runs: a notebook file is in recency order, and a vote moves its line to the end. A test keeps the README under 60,000 characters and its links resolving.

- **Links to the old README sections keep working, and the duplicate rule is described the same way everywhere.** The sections that moved to `docs/` keep their old anchors in the README, next to the pointer to their new home. `AGENTS.md`, `docs/requirements.md`, `docs/harness-setup.md`, `docs/memory-layers.md` and `examples/nb-janitor.mjs` said a duplicate was the same text with "case, punctuation and spacing ignored"; they now say what `nb` does: case is ignored and every character other than a–z and 0–9 is read as a word break, so accented and non-Latin letters do not count as letters.

- **The harness docs now say what the example hooks do not cover in long sessions and with subagents.** `docs/harness-setup.md` and `examples/hooks/claude-code/README.md` stated that Claude Code has no `SubagentStart` hook; it has one. They also described the retrospective nudge as arriving "when the task ends". It arrives at one stop per session, which in an interactive session can be the end of the first reply. The docs now list what the example hooks leave uncovered (one nudge per session, no nudge for subagents, agents that opened no notebook adding nothing), what to do about each, and a transcript audit that shows whether subagents take part. `nb stats` cannot show these: it reports a session as engaged from its first vote. `AGENTS.md` §③ now tells the lead to put the contract in each subagent's brief.

### Fixed

- **The example retrospective hook keeps its nudge for the lead's real stop, and never nudges a subagent (#520).** It nudged once per session at the first stop of any agent. A lead that delegated to background agents spent the nudge the moment it began waiting, and a subagent that stopped first took it, its answer to the nudge then replacing the report its caller receives. A `Stop` whose payload lists background work still pending or running (a subagent, workflow, teammate or cloud session) is now let through without using up the nudge, and a `SubagentStop` is never nudged: `examples/hooks/claude-code/settings.json` registers the hook under `Stop` only. **If you copied the hooks, copy `nb-retrospective.sh` again and drop it from `SubagentStop` in your settings.**
- **The retrospective hook honours `off` in the directory the agent is working in (#517).** It asked `nb enabled` only from `CLAUDE_PROJECT_DIR`, so an agent working in a switched-off repository inside an on project was still nudged, although its own `nb list` had told it to skip the notebook steps. It now asks from the hook payload's `cwd` too, and an `off` from either wins. An `off` from the payload `cwd` alone does not use up the session's one nudge.
- **`nb stats` no longer counts an `nb list` that answered "off here" as a read (#517).** That row shows no index, so counting it hid the "SessionStart injection hook is probably not wired" cause in a store used from switched-off repositories.

## [0.10.0] - 2026-11-18

### Added

- **A per-repository on/off switch for the agent-facing loop: `nb enabled` and `git config nb.enabled` (#514).** With the hooks installed machine-wide, the notebook ran in every repository. `git config nb.enabled false` now switches it off in one repository (stored in `.git/config`, so never committed and shared by its worktrees), `git config --global nb.enabled false` switches it off everywhere, and a repository's own `git config nb.enabled true` switches it back on there, so "off everywhere except one repository" is two commands; `includeIf` covers a folder. `NB_ENABLED` (`0`/`false`/`no`/`off` = off, any other non-blank value = on) overrides git config for one process, for example `"env": { "NB_ENABLED": "0" }` in a committed `.claude/settings.json`. The default stays on. `nb enabled` prints `on` or `off` (`--why` adds which setting decided, `--json` a structured object) and fails open: a missing `git` or an invalid value resolves to on, with a warning. `nb config` gains an `enabled=` line and an additive `enabled` key in `--json`. Both Claude Code example hooks now ask `nb enabled`: when off, the session-start hook prints one line telling the agent to skip the notebook steps instead of the index, and the retrospective hook lets the stop through. **If you copied the hook scripts, copy them again** to get the check. For a setup with no hooks (Codex CLI, or a contract in a global `CLAUDE.md`), the text form of `nb list` asks the same question: in an off repository it prints one line telling the agent to skip the notebook steps in place of the index, exits 0, and logs its usage row with outcome `off`. `NB_ENABLED=1 nb list` shows the index anyway, and `nb list --json` is never affected. The Codex snippet and `AGENTS.md` now say to skip every notebook step when `nb list` reports off, so the Codex snippet can go in `~/.codex/AGENTS.md`. The shell-completion scripts and the session-start hook run their own `nb list` with `NB_ENABLED=1`, so shelf names still complete in an off repository; re-run `nb completion` if you saved its output to a file. `nb show`, `nb add` and the other commands are not locked. See [per-repository on/off](https://github.com/jeanibarz/agent-notebook/blob/main/docs/harness-setup.md#per-repository-onoff).

## [0.9.0] - 2026-11-17

### Fixed

- **`nb stats` no longer overstates how long a lesson lasts on a full shelf when the usage log is shorter than the window (#511).** Each shelf's adds per day was computed by dividing its adds by the whole `--since` window (7 days by default), even when the usage log had reached its row cap and its oldest row was newer than the window start. The adds had then been recorded over fewer days, so the rate read low and the `~Nd retention` estimate long: on one host whose log reached back 5.19 of 7 days, a 50-line shelf printed 20.29 adds/day and `~2.5d retention` instead of about 27.4 adds/day and `~1.8d retention`. In that case the rate now divides by the days from the oldest row to now. The divisor is never less than one day (or the whole window, if that is shorter). When the log covers less than the divisor, the printed rate is a lower bound on the true rate and no retention is printed (`retentionDays: null`). The note under the `usage ring` line now says which span the rates use (`per-day rates divide by the time since that row`), replacing the old `computed over a longer span than is recorded` wording; a script matching that text sees the new one. When the log reaches back to the window start, the numbers are unchanged. `addsPerDay` and `retentionDays` keep their names and types in `--json`.
- **`nb stats <shelf>` no longer exits 1 when a different shelf cannot be read (#482).** When no session in the window had voted, the scoped report counted the lessons on every shelf for its engagement diagnosis and read each one unguarded, so a directory named `weird.md` or a file without read permission anywhere in the store aborted it with `EISDIR`/`EACCES`, while `nb stats` with no shelf skipped that file and still reported. The scoped count now skips an unreadable shelf the same way and counts 0 lessons for it, so both forms count the same lessons. In that case, the only one where the scoped report reads other shelves, the skipped shelf is named on stderr (`nb stats: skipped shelf "weird" — could not read weird.md (EISDIR); …`) and in the `--json` `skipped` field; when a session has voted, `nb stats <shelf>` reads no other shelf and prints no such note. A file whose name is not a valid shelf name is still left out of the scoped count without a note. Output is unchanged when every shelf is readable.
- **`nb constructor`, `nb toString`, `nb __proto__` and other names every JavaScript object has are now unknown commands (#483).** `nb` looked the command word up in plain-object tables, so these names were treated as known and crashed with a TypeError (`function is not iterable`), exiting 1 with error class `other`. They now get the usual `unknown command "…". Try `nb --help`.` message and exit 2, the usage log records `unknown_subcommand`, and `--json` emits the same structured error as any other unknown command; `nb constructor --help` exits 2 like `nb bogus --help`. Real commands are unaffected.
- **`examples/nb-janitor.mjs` now reads `NB_MAX_LINES` and `NB_USAGE_RING`, and decides which files are shelves, the same way `nb` does (#484).** The janitor took the leading digits of an env value, so `NB_MAX_LINES=1e3` gave a 1-line cap and reported every shelf full, while `nb` ignores `1e3` and uses 50; `NB_MAX_LINES` was also not clamped to 1–5000. It also counted files `nb list` skips as invalid shelf names: names over 128 characters and Windows device names such as `con.md` or `nul.notes.md`. Both now follow `nb`, so the janitor's numbers can change on a store that used such values or files. Tests run the janitor and `nb` on the same store and require the same caps and the same shelves.
- **`nb stats` no longer flags `browse-without-use` on a shelf that does not exist, and ranks the rest by voted share (#480).** `nb show` of a never-created shelf exits 0 and logs an ordinary `show` row, so on one host a quarter of the flags (117 of 463 pairs, 50 of 105 shelf names) named a shelf with no file and no description to fault. Such a `show` is now logged with outcome `no-shelf` and never counted, even when a later `add` in the same session creates the shelf; rows already in the log are skipped when their shelf still has no file at report time (a shelf deleted during the window is skipped the same way). The text report prints both counts per shelf (`shelf patch-author: shown in 15 sessions, voted in 3 (20%)`), sorted by voted share, lowest first, instead of by the unvoted count that put the busiest healthy shelves on top. Shelves shown in fewer than 3 sessions fold into one summary line pointing at `--json`. "The notebook's description may over-promise" now appears only on a listed shelf voted in under a quarter of its sessions, and is dropped from each pair's `detail`. In `--json`, `signals[]` still has one entry per (session, shelf) pair, and each `browse-without-use` entry gains `shown` and `voted` (the shelf's session counts); a script matching the old `detail` or line text sees the new wording.
- **The layered session-start index now marks an auto-derived shelf description with `(auto)` (#453).** With `NB_PROJECT_SLUG` set, the example hook printed a shelf's top lesson in place of a missing `# desc:` with no marker, so an undescribed shelf read as described, unlike `nb list` and the flat index. The fallback now ends in `  (auto)`; real descriptions are unchanged. Tests assert both cases.
- **`nb merge` now reports a third lesson it absorbs (#454).** When the merged text matches a lesson that is not one of the two being merged, that lesson is dropped so no duplicate is created, and the merged entry keeps only the higher of the two sources' scores. A `+5` lesson could silently become `+1` with the output saying only `merged two entries into one`. The line now ends with `(also absorbed [+5] <text>, identical to the merged lesson)`, and `--json` carries an `absorbed` array (empty when nothing was absorbed). Scores are unchanged: whether the merged entry should inherit the absorbed score is a separate decision.
- **`nb stats` now reports a voted lesson evicted by `nb split` or `nb merge` (#455).** The `eviction-while-still-voted` signal read only `add` rows, so a tidy-up command that pushed an upvoted lesson off a full shelf was logged in the usage row's `evicted` column but never surfaced. `merge` and `split` rows now count, under the same upvote and score rules as `add`. `move` is still not read: its row is filed under the source shelf while the eviction happens in the target. More signals may appear on existing stores; `--exit-code` is unaffected because signals are not anomalies.
- **Shell completion now offers every shelf, not only the richest 50 (#456).** The bash and zsh scripts read shelf names from a bare `nb list`, which stops at 50 rows, so on a store with more than 50 shelves the newest and smallest never tab-completed (60 shelves `shelf1`…`shelf60`: `nb show shelf5<TAB>` offered only `shelf50`). The scripts now run `nb list --limit 1000000`, and the shipped `examples/completion/` copies are regenerated. Re-source or re-copy the script to pick this up. A test covers a 60-shelf store.
- **The README Usage block now lists every command form and flag `nb --help` does, and per-command help names `--reason` and `--json` where they work (#457).** The README was missing `nb stats --exit-code`, multi-shelf `show`, `--json` on `show`/`stale`/`path`, `describe <shelf> -`, batch `vote` and `--version`; it now carries the help usage lines verbatim plus a one-line exit-code note. The help notes now list `move` among the `--reason` commands and `split`/`describe` among the `--json` commands, so `nb move --help` and `nb split --help` mention them. Tests fail if a help usage line is missing from the README or a command's flag is missing from its scoped help.
- **`nb --help` now says eviction ties go to the stalest line, not the oldest (#458).** The code and spec break a tie by staleness (the least recently touched line, at the top of the file), so an old lesson that was voted recently survives a tie. The help line and a test title said "oldest"; both now say "stalest", and a test pins the help wording.
- **Rewriting a shelf or compacting the usage log no longer resets its permissions (#459).** The temp-file-and-rename write gave the new file the umask default, so the first `add`, `vote`, `describe`, `merge`, `split` or `move` after a `chmod 600` made the shelf 644 again (a group-writable `660` lost group write), and the usage log reverted to 644 at its first compaction. The replacement now keeps the original's permission bits (not its owner or group); new files still get the umask default (FR-DUR-002).
- **The Claude Code retrospective hook no longer builds its sentinel file name from a raw `session_id` (#460).** An id containing `/` or `../` wrote outside `NB_DIR` or failed with ENOENT and nudged on every stop. The id is now reduced to `[A-Za-z0-9._-]` (other characters become `_`) and capped at 128 characters; UUID-shaped ids keep the same `.retro-<session_id>` name.
- `nb merge`, `nb split`, `nb move` and the `nb stats` inventory now print `1 line`, not `1 lines`, as `nb add` already did (#462). `move`'s message gives each shelf's count its own unit (`"from" now 0 lines, "to" now 3 lines`, where it printed `now 0, … now 3 lines`). A script matching the old text exactly sees the new wording; the `skipped (a near-duplicate already lives in …)` prefix is unchanged.
- `nb stats` now raises `eviction-while-still-voted` for a lesson that was upvoted in the usage window and then evicted at 0 or above, not only one evicted above +1. The staleness dock takes an upvoted lesson down to +1 or 0 before it leaves a full shelf, so the old test never fired (0 of 191 evictions measured). The detail line gives the upvote count (a lower bound: older votes are outside the log window) (#438). The example janitor reads shelf git history, not this signal, so its "2 or more" threshold is unchanged.
- **A large batch `nb vote` no longer holds the lock for seconds (#463).** A batch vote computed the id of every lesson on the shelf again for each id it resolved, so its cost grew with ids × lessons. It now computes them once per call. On a 5000-line shelf (`NB_MAX_LINES=5000`), a 50-id vote went from about 1.0–1.1 s to 0.15–0.20 s and a 200-id vote from 4.0–4.8 s to 0.20–0.26 s. At the default cap of 50 lines the difference is negligible. Which lesson each id selects, and every error message, are unchanged.
- `examples/nb-janitor.mjs`: section 2 (near-duplicate shelf names) now prints at most 25 similar-name pairs, strongest first, then `…(N more pairs — run with --json)`, like the other capped sections (#461). Pairs grow quadratically, so 60 shelves `issue-101` … `issue-160` used to print 411 pairs and push the later sections off-screen. `--json` still lists every pair.
- **`nb add` no longer suggests `nb merge` for a resembling lesson that the same add evicted (#451).** When the new lesson resembled a line and that line was the one evicted to make room, the `note: resembles …` hint named an id that was no longer on the shelf, so the suggested `nb merge` failed. The note now reads `note: resembles a lesson this add evicted: "…"` with no merge command; a resembling lesson that survives gets the usual hint.
- **The git merge-conflict marker quoted in `nb` warnings and errors is now escaped (#441, #445).** The read-side warning and the refusal that `add`, `vote` and the other mutating commands print quoted the marker line with `JSON.stringify` only, which left DEL, C1 controls (such as U+009B), U+2028/U+2029 and Tag characters raw on the terminal. Both messages now escape it the way skipped-file lines and `nb doctor` already do. Ordinary markers print the same as before.
- **AGENTS.md now says only identical lessons are skipped (#452).** It said near-duplicates were skipped, but a reworded lesson is stored with a `note: resembles …` on stderr. The text now says so and tells the agent to consolidate with `nb merge` rather than keep both variants.

### Changed

- **A bare `npx vitest run` no longer tests a stale build (#420).** The tests run `dist/cli.js`, and only `npm test` rebuilt it first. A Vitest global setup now runs `npm run build` when `dist/cli.js` is missing or older than a non-test file under `src/`, and does nothing when `dist/` is current. `npm test` is unchanged. Contributor tooling only; the `nb` CLI is unaffected.
- **A run of adds no longer drains one voted lesson (#437).** When a full shelf takes a new lesson it still evicts its lowest-scored line and docks the stalest survivor by one point, but the docked lesson now moves to the end of the file, as it does after a vote. Before, it stayed at the top and took every following dock until it was evicted, so a +4 lesson that nobody had voted for lately could be removed by one session adding four lessons. Now each add docks the next quiet lesson in turn (with a cap of 2 there is only one), and a lesson is docked again only after the aging has passed over the rest of the shelf. With a cap of ten, ten lessons at +3 and twenty unrelated adds, nine survive the first eleven adds (before: one lost every two adds, none left after twenty). The cap is fixed, so unvoted lessons leave sooner: on a shelf where every other lesson is voted well above +1, in a run of adds with no votes between them, a new lesson is evicted by the add that follows it, unless a quiet lesson had already been worn down to +1 when it arrived (so the first ten new lessons go, in the example above). The line format and the commands are unchanged; right after it is aged, a line appears last within its score in `nb show`. See [eviction-and-aging.md](docs/eviction-and-aging.md), [DP-3](docs/requirements.md#dp-3) and [FR-ADD-006](docs/requirements.md#fr-add-006).

## [0.8.0] - 2026-11-12

### Added

- **`nb doctor` reports a lesson that appears twice in one shelf (#413).** Two identical lessons in one shelf, which is what a "keep both" git merge leaves, share one id, so no command can select either. `nb doctor` now lists them under the finding code `duplicate-lesson`. `nb doctor --exit-code` therefore exits 3 on a store with such a shelf, where it used to pass.
- **`nb` says when an over-cap add ages another lesson (#294).** When a shelf goes over its cap, the lesson that has gone longest without a vote loses one point. That used to happen with no output and no record of it in the usage log. `add`, `merge` and `split` now print `(aged stalest −1 → [score] text)` when the aged lesson's score was above +1; `move` prints `(aged stalest in "<target shelf>" −1 → [score] text)`. Every such change is recorded in a new `decayed` column of the usage log (`<id>:<score after>`). `split` now also reports what it evicted.
- **`--json` returns a structured error when a command fails (#266).** A failing command under `--json` used to write only an English sentence to stderr and nothing to stdout. It now also writes `{ ok: false, command, error: { class, message } }` to stdout, where `class` is the same error class the usage log records; an unknown command uses the class `unknown_subcommand`. When a flag value is invalid and a default is used instead (`stats --since`, `--limit` on `search`/`list`/`stale`), a `{ warning: { class: "defaulted_flag", … } }` line goes to stderr. The English stderr lines and all exit codes are unchanged.
- `examples/nb-git-wrapper.mjs`: opt-in `NB_GIT_SESSION_TRAILER=1` adds a `Nb-Session: <NB_SESSION>` line to each auto-commit body so history shows which task changed a lesson (#409).
- **`npm run typecheck` now type-checks the test files and both vitest configs (#382).** A new `tsconfig.test.json` (extends the build config, `noEmit`, `rootDir` at the repo root) covers `src/**/*.test.ts` and `vitest*.config.ts`, which the build's `tsconfig.json` excludes; `typecheck` runs both projects and one CI leg runs it. The 26 errors it surfaced are fixed: nine stale `UsageRow` fixtures now go through one typed `usageRow()` helper, five `@ts-expect-error` directives that asserted nothing are removed, and a declaration file types `scripts/check-node-for-tests.mjs`. `dist/` and the published package are unchanged.
- **`nb-janitor` reports slug drift and exact duplicate lessons across `shelf@project` shelves (#362).**
  Two new read-only signals in the example janitor (`examples/nb-janitor.mjs`; no change to any `nb`
  command, its output or the shelf file format). Section 2 now also flags *possible slug drift*: one base
  name under two slugs where the shorter is the longer with a leading part dropped (`code-review@app` and
  `code-review@acme-app`), with the `nb move` that would fold them. A new section 8 lists a lesson that
  two or more `@` shelves of the same base hold, by `nb`'s own exact-duplicate rule (the `dedupKey`), with
  the highest-scored copy and the `nb move` / `nb rm` to keep one. Both appear in the human report and in
  `--json` (`slugVariants`, `crossShelfDups`). See [FR-JANITOR-001](docs/requirements.md#fr-janitor-001).
- **`nb doctor` reports the structural problems the other commands tolerate silently (#338).**
  A read-only scan (no lock, no writes) of the notebooks directory listing, per shelf and line, git
  merge-conflict markers, lines without a valid `<score>\t` prefix, control/bidi characters, lessons over
  `NB_MAX_CHARS`, shelves over `NB_MAX_LINES` and 0-byte shelf files, plus case-colliding shelf names,
  leftover `*.tmp` files (older than the stale-lock threshold) and a stale `.nb.lock`. Each finding has a stable `code`. `--json` emits
  `{schemaVersion, shelves, findings}`; `--exit-code` exits 3 when anything is found (same convention as `nb stats`).
- **`nb stats` shows each shelf's add rate, the retention window of a full shelf, and sessions that add in bursts (#353).**
  On a full shelf each add evicts a line, so an untouched lesson lasts about `cap ÷ adds per day`, and nothing
  showed that rate. Each shelf row now prints its accepted adds in the window (`N adds (R/day)`) and, when full,
  `~Dd retention`; `--json` gains `adds`, `addsPerDay` and `retentionDays` per shelf (additive, schema version
  unchanged). A new `add-burst` signal flags a session that accepted more than `NB_ADD_BURST_N` (default 15) adds
  into one shelf. Docs now say the first remedy for a short window is fewer adds per session.
- **`nb add` says when it creates a shelf, and names existing shelves with overlapping names (#354).**
  `add` is the only mutation that may name a shelf that does not exist, and it printed the same
  `added — 1 line` either way, so two sessions coining different descriptive names for one subject
  went unwarned. When `add` creates a shelf it now prints one advisory line on stderr — the new
  shelf, up to three existing shelves sharing at least two name words with it (split on `-` and
  `.`, lexical only), and the `nb move` that would consolidate — and `--json` carries `created` and
  `similarShelves`. Non-blocking: the lesson is stored and the exit code is unchanged.
- **`nb config` now reports whether each env tunable was honored, clamped, or ignored, and flags unknown `NB_*` vars (#336).**
  The source tag only checked whether a var was *set*, so an unparseable value (silently replaced by the
  default), an out-of-range value (silently clamped) and a typo like `NB_MAX_LINE` (never read) were all
  invisible or mislabeled — `NB_MAX_LINES=abc` printed `maxLines=50 (env NB_MAX_LINES)`, as if `abc` were
  in force. Each set numeric tunable now reports how its value was resolved: `honored`, `clamped` (with the
  raw value, e.g. `(env NB_NEAR_DUP: clamped to 1 from 2)`), or `ignored` (`(env NB_MAX_LINES: ignored
  "abc", not an integer; using default)`). `nb config --json` gains additive `status` and `rawValue` fields
  on each numeric row (`source` and every existing key unchanged). Integer knobs must be a whole integer, so a
  partially-numeric value (`1e3`, `12.9`) is `ignored` rather than silently truncated by `parseInt` to `1`/`12`.
  Any `NB_*` var `nb` does not read is listed as `not read by nb` (with a nearest-name `did you mean` hint) in
  both outputs, derived from the same variable registry `effectiveConfig` uses — informational only, never an
  error, exit code stays `0`. The knobs read only by the tooling shipped under `examples/` are not flagged.
  Output for a config with no problems is byte-identical to before. See
  [FR-CONFIG-001](docs/requirements.md#fr-config-001).
- **`nb stats` now surfaces crash/interrupt recovery, so silent mid-write crashes become observable (#309).**
  Two recovery paths each mean a previous `nb` died mid-mutation — the stale-lock steal (`withLock`)
  and the leftover-temp reap (`reapLeftoverTemps`) — yet both were entirely silent, so an operator
  running `nb` from agent hooks could not answer "are my agents crashing mid-write and losing updates?".
  Each usage row now carries a `recovered` column (`<lockSteals>:<tempReaps>`, blank in the
  common case), and `nb stats` sums it window-wide into a new `crashRecovery: { lockSteals, tempReaps }`
  readout — shown as a `crash recovery: N stale locks stolen, M leftover temps reaped (window)` line in
  the human table and under a new top-level `crashRecovery` key in `--json`. Like the usage-ring
  occupancy readout it is deployment-wide (the lock and temp debris are shared across shelves), so a
  `[<shelf>]` scope does not narrow it; only the window applies. A clean deployment reports `{ 0, 0 }`,
  shown rather than omitted so "measured, healthy" is never confused with "not measured". The recovery
  actions themselves are unchanged and the counting is best-effort — a logging failure never fails a
  mutation. `STATS_SCHEMA_VERSION` stays `1` (the field is additive). See
  [FR-STATS-007](docs/requirements.md#fr-stats-007).
- **`nb config` now reports the behavior-critical string env vars `NB_DIR`, `NB_SESSION`, and `NB_ASCII` (#312).**
  The command listed only the 14 numeric clamp tunables, so the three string env vars that most often
  explain a misbehaving deployment were structurally invisible — including `NB_SESSION`, whose unset
  state is the usual cause of `nb stats` reporting "no engaged sessions". A new `environment` section
  prints each as `NAME=value`, read from the same resolver the hot path uses (`notebooksDir()`, the
  effective `NB_SESSION`, `asciiMode()`), tagged `(env)` or `(default)` like the numeric rows. Under
  `--json` the vars live under a new top-level `environment` key (`{ value, source }` each); the numeric
  rows keep their exact keys and `{ value, source, env }` shape, so the `--json` contract stays
  backward-compatible. See [FR-CONFIG-002](docs/requirements.md#fr-config-002).
- **`nb show` reads several shelves in one call, and `--json` entries now carry a dedup `key` (#286).**
  `nb show <a> <b> <c>` now prints every named shelf instead of silently dropping all but the
  first, and under `--json` returns a per-shelf array of `{shelf, description, entries, exists}`
  in one process — one consistent snapshot, no N spawns. A single shelf stays a lone object
  (backward compatible); a named shelf with no file reports `exists: false`, never a silent empty.
  Each `--json` entry gains a `key` field: the `dedupKey` normal form of its text (case- and
  punctuation-folded, whitespace-collapsed). Two entries with an equal `key` are *exact*
  duplicates — the one thing a caller cannot reproduce without reimplementing nb's internals — so
  a harness composing a context pack from several shelves can drop exact cross-shelf dupes itself.
  `key` is equality-only; nb does no cross-shelf dedup, ordering, scope precedence, or similarity
  ranking on this path — those stay caller policy. See [FR-SHOW-004](docs/requirements.md#fr-show-004).

### Changed

- **`nb-janitor` section 8 counts a copy in the bare `<base>` shelf as a duplicate holder (#362).**
  A lesson in `code-review` and in `code-review@my-repo` is now reported (previously only two or more
  `@` shelves were). The bare shelf is the shared one, so the suggestion is only `nb rm` for the `@` copies.
  The "blocked move target" note no longer appears when no move is needed.

### Fixed

- **`nb stats` no longer gives two different cause splits for the same failed calls (#418).** On a usage log that still held rows from before error classes were recorded, the `error causes:` line read an old over-length `add` as `too_long` while the `high-error-rate` anomaly read the same row as `unclassified` (one real report showed `too_long 96%` on one line and `too_long 50%, unclassified 48%` on the other). Both lines now use one rule, so they agree on the same error rows; a row with neither a class nor an error outcome is still `unclassified`.
- **A truncated `nb list` now says which notebooks it left out (#407).** The default 50-row cap drops the shelves with the fewest lessons, which are the newest ones, and the only hint was the `50 of 53` header. Without an explicit `--limit`, the output now ends with a flush-left `# 3 more notebooks not shown … nb list --limit 53` line, so the SessionStart hook carries it too. `--limit` and `--json` output are unchanged; AGENTS.md, the README, the getting-started guide and the hook hints no longer claim a bare `nb list` shows everything. See [FR-LIST-001](docs/requirements.md#fr-list-001).
- **`nb stats` now prints one `browse-without-use` line per shelf instead of one per session (#415).** The text report folds the signal into `shelf s: shown without a vote in 29 sessions`, busiest first. `--json` is unchanged and still lists every (session, shelf) pair.
- **The documented git-wrapper shim no longer spawns `npm root -g` on every `nb` call (#405).** The recipe now writes the global npm root into the shim as `NODE_PATH` once (only if that directory exists), so the wrapper resolves the package without npm, saving about 120 ms per call. A shim without it, or with a stale root, still works through the existing npm fallback; rewrite the shim after switching Node versions or npm prefix.
- **`nb move` and `nb describe` now say when they create a shelf (#404).** A mistyped move target or `describe` shelf started an orphan shelf with only the normal success line. Both now print the same stderr `note: created new shelf` that `add` prints (naming overlapping existing shelves), and their `--json` result carries additive `created: true` / `similarShelves` only when a shelf was created. Moves refused as duplicates, existing shelves and cleared descriptions print nothing new. See [FR-NOTE-001](docs/requirements.md#fr-note-001).
- **`examples/nb-janitor.mjs` now reads mass evictions and batch votes (#403).** It parsed `evicted` as one `<id>:<score>` pair and counted one vote per `vote` row, so a lowered `NB_MAX_LINES` showed an all-clear while `nb stats` flagged each voted loss, and batch votes were undercounted. It now parses the comma list (skipping the `+<n>` overflow token) and counts one vote per id; `LOSS_MIN` is unchanged.
- **A short hex selector no longer silently picks an id over the lesson text that mentions it (#412).** `nb rm s 18` removed the lesson whose id began `18` while the lesson mentioning "Node 18" stayed, exit 0. A hex selector shorter than a full id that uniquely prefixes one id but is also a substring of a different lesson now exits 1 with `ambiguous_selector`, listing both and changing nothing; a full 6-character id always resolves directly. Only refusals are added; in a batch vote the refusal is a per-selector miss. FR-SEL-001 and the README selector text are updated.
- **`nb-backup.sh` no longer commits and pushes an unresolved git merge (#399).** With `NB_DIR` mid-merge or mid-rebase, `git add -A` marked the conflicted shelf resolved and the job published its `<<<<<<<` markers while logging success. It now checks for unmerged paths, `MERGE_HEAD`, `rebase-merge` and `rebase-apply` under the git lock; if any is present it commits and pushes nothing, logs `MERGE IN PROGRESS`, and exits 1.
- **`nb <command> --help` / `-h` and `nb help <command>` now print that command's own usage (#370).** Previously `--help` after a subcommand was rejected as an unknown option, and `-h` was stored as data (`nb describe <shelf> -h` overwrote the description). The scoped text is sliced from the full help, so it cannot drift; the call is logged as `help`. A literal `-h` is still storable after `--`.
- **`nb-backup.sh` no longer skips its straggler commit when the git lock is released mid-acquire (#371).** After a failed `mkdir` of `.nb-git.lock` the script treated an already-absent lock as an unwritable store and gave up at once, logging a misleading `busy after Ns`. It now retries, gives up as unwritable only after 3 consecutive failures (with its own message), and reports the time actually waited.
- **The usage log no longer records raw arguments in its `shelf` and `command` columns (#375).** A shelf operand that is not a valid shelf name (e.g. a lesson typed with the shelf forgotten) is logged as `-`; both columns are capped like `note`/`session`; control characters (ESC, BEL) are dropped from every column on write; and `nb stats` strips them from log-derived output, including rows written by older versions.
- The documented git-wrapper install no longer breaks every `nb` call: the wrapper falls back to the global npm root when it cannot resolve `agent-notebook` from its own location, says what it searched when it still fails, and the install is now a `.mjs` copy behind a one-line `nb` shim (an extensionless copy fails on older Node, e.g. 18 and 22.5). (#376)
- **`nb` now rejects surplus operands instead of silently dropping them (#378).** `nb add s run lint first` used to store `run` and exit 0; an unquoted `nb merge` replaced two lessons with one word, and a repeated `--note`/`--reason` was stored as the lesson or description. `add`, `merge`, `split`, `rm`, `vote`, `move` and `describe` now exit 1 with `bad_args` naming the first extra word and saying to quote the text as one argument; a repeated `--note`/`--reason` is refused too. `show` is unchanged (`search` got its own check, #402 below), operands after `--` count but stay literal, and a trailing `--` on `vote` is still a downvote.
- **`npm run test:fast` and `npm run test:coverage` now build `dist/` first (#379).** Ten suites exec the built `dist/cli.js`, but only `npm test` rebuilt it, so the fast loop failed on a fresh clone and could pass green against a stale build. `pretest:fast` and `pretest:coverage` hooks run the build like `pretest` does; the script strings are unchanged. `test:watch` still does not build, and CONTRIBUTING and AGENTS now say so.
- **`nb doctor --json` now includes the `shelves` count its spec promised (#381).** A gate pointed at an empty or mistyped notebooks directory could not be told from a clean one. The human line now says `0 shelves checked (the notebooks directory does not exist | holds no shelf)` and pluralizes (`1 shelf`). Exit codes and finding codes are unchanged (an empty directory still exits 0).
- **`nb list`, `nb search` and `nb stats` no longer report an unreadable notebooks directory as an empty store (#383).**
  Before, any failure to list `NB_DIR` (permissions, an I/O error, a regular file where the directory should be)
  printed "no notebooks yet" and exited 0, so a session-start hook could not tell a broken store from an empty one.
  Only a missing directory still means empty. Any other errno now fails the command with one stderr line naming
  the directory and the code, for example `nb list: cannot read notebooks directory "/x" (EACCES)`, and exit 1; `--json`
  carries the usual structured error object. `nb doctor` fails the same way instead of reporting a clean store,
  and `nb add` into a directory it can write but not list (mode `-wx`) now fails with the same message instead
  of writing a shelf no `nb list` could show. See [FR-LIST-007](docs/requirements.md#fr-list-007).
- **`nb-janitor --json` is no longer cut off when piped, and the janitor reads shelves the way `nb` does (#362).**
  The `--json` path called `process.exit()` straight after writing, and a pipe write is asynchronous on
  macOS, so a report larger than the first 8 KB chunk reached the consumer truncated and `JSON.parse` failed;
  it now waits for the write to drain. The shelf reader also now strips a leading byte-order mark, accepts CRLF
  line endings, deletes control and zero-width characters before collapsing whitespace, and treats only the
  leading `# key:` lines as metadata, as `nb` does; a closed pipe (`| head`) still exits 0. Before, a BOM-prefixed `# desc:` line counted as a lesson
  (and the shelf as undescribed in section 7).
- **A new shelf whose name differs only by case from an existing one is refused (#337).**
  `Foo.md` and `foo.md` coexist on Linux but are one file on default macOS/Windows filesystems, so a git-synced
  notebook could not be checked out cleanly, or a write to `foo` landed in `Foo`. `nb add`, `nb move` (target)
  and `nb describe` now exit 1 naming the existing shelf instead of creating the variant. Existing shelves and
  already-colliding pairs are untouched.
- **A shelf with git merge-conflict markers is no longer silently rewritten as clean lessons (#333).**
  After a `git pull`/`git merge` conflict in a git-versioned notebook, the `<<<<<<<`, `=======` and `>>>>>>>`
  lines parsed as score-0 lessons, and the next `nb add|vote|rm` wrote them back as real lessons — erasing the
  only signal that a merge needed resolving, evicting real lessons against the cap, and injecting junk into
  agent context. `nb` now recognizes the three exact marker shapes at line start (a bare `=======`, or
  `<<<<<<<`/`>>>>>>>` followed by a space or end of line); a mid-line `=======` or an ordinary hand-edited
  tab-less line is still a normal tolerated lesson. Read commands (`show`, `list`, `search`, `stale`) still
  print exactly as before but add one stderr warning naming the shelf and marker (`--json` stdout stays valid
  JSON, with only the additive fields described next); the same shelves appear in the additive `conflicts` field of `nb list`/`nb search`
  `--json` (emitted, together with `skipped`, only when either of the two is non-empty, so one of them can be `[]`) and of `nb stats --json` (always present, `[]` when clean, like `skipped`). Every mutation (`add`, `vote`, `merge`, `split`, `rm`, `move`,
  `describe`) refuses with exit 1 and a new `corrupt` error class that names the shelf and marker line, leaving
  the file byte-identical. See [FR-MODEL-004](docs/requirements.md#fr-model-004).
- **One unreadable shelf no longer takes down `nb list`, `nb search` and the session-start index (#332).**
  The cross-shelf scans read every `<shelf>.md` with no per-shelf error handling, so a single
  non-`ENOENT` read failure — `EACCES` on a root-owned or `chmod`'d file left by a `sudo nb`, `EISDIR`
  for a directory named `<shelf>.md`, `EIO` — aborted the whole command, turning every accumulated
  lesson into "nb failed". `listNotebooks` and `search` now skip only the unreadable shelf, keep every
  healthy one, and exit `0`; the skip is surfaced as a `{shelf, code}` entry in the additive
  `NotebookListing.skipped` / `SearchResult.skipped` field (emitted in `--json`, together with `conflicts`, only when either of the two is
  non-empty, so one of them can be `[]` and healthy output is byte-identical) and, outside `--json`, as one stderr line naming the shelf and errno. The same resilience
  covers the `nb stats` inventory (`StatsReport.skipped`), since a health scan of a damaged store is exactly
  where aborting hurts. Only a real errno failure is skipped — a codeless throw (a parser bug) still
  propagates rather than being mislabelled. A prefix/scope whose only match is the skipped shelf reports it
  was unreadable (not "no match"), and a search miss caused only by a skipped shelf logs outcome `skipped`
  instead of `no-match`, so it cannot masquerade as a coverage gap. Single-shelf commands
  (`nb show <bad-shelf>`, …) still fail loudly. See [FR-LIST-006](docs/requirements.md#fr-list-006).
- **`nb stats <shelf>` no longer lets a typo read as a real but silent shelf (#341).**
  `stats` takes a shelf operand but, unlike the mutations (which answer an unknown shelf with a
  did-you-mean, #200) and `show` (which distinguishes missing from empty, #166), never validated it —
  so a misspelled shelf produced a plausible, empty report indistinguishable from a real shelf with no
  recent activity, the exact wrong conclusion a command built to surface unused shelves must not invite.
  When the operand has no `<shelf>.md` **and** the window holds no usage rows for it (ignoring `stats`' own
  rows, so the note repeats on every call), `stats` now prints one advisory note on **stderr** — `nb stats: no shelf named "X"`,
  plus `— did you mean "Y"?` when a shelf is close (reusing #200's `closestShelf`). It is advisory only:
  the exit code and stdout (the human table and the `--json` `StatsReport`, still one valid object) are
  unchanged, and a retired shelf that still has historical in-window rows is not flagged. See
  [FR-STATS-009](docs/requirements.md#fr-stats-009).
- **Lessons and descriptions can no longer inject terminal escape sequences (#335).**
  `sanitizeLesson` only collapsed whitespace, so ANSI/OSC escapes, NUL/BEL, C1 controls,
  bidi overrides and zero-width characters were stored verbatim and echoed raw by
  `nb show`, `nb list` and `nb search` (and injected into harness context). `sanitizeLesson`
  now strips C0 controls (except tab/LF/VT/FF/CR, which still become a space), DEL, C1 controls, bidi
  embedding/override/isolate marks and zero-width characters, while keeping ZWJ and
  variation selectors so emoji survive; the render paths strip the same classes too, so a
  shelf file stored before this rule cannot emit an escape either. Zero-width characters
  no longer defeat the exact-duplicate check. See
  [FR-MODEL-002](docs/requirements.md#fr-model-002).
- **`NB_DIR` with a leading `~` is expanded by `nb` itself instead of creating a literal `~` directory (#334).**
  `notebooksDir()` used `NB_DIR` verbatim, so a value like `~/notes` set from a place
  that does no shell expansion — Claude Code `settings.json` `env`, Codex config,
  systemd units, cron, `.env` files — made `nb` write into a directory *literally*
  named `~` under the current working directory. Each hook from a different project
  then forked a new, empty notebook; `nb add` exited `0` but the next session looked
  empty. A leading `~` (or `~/…`, and `~\…` on Windows) now expands to the home
  directory for every path `nb` derives from it (shelves, the usage log, `nb path`,
  `nb config`). The shipped helpers
  (`examples/nb-git-wrapper.mjs`, `nb-janitor.mjs`, `nb-backup.sh` and the Claude Code
  `nb-retrospective.sh` hook) expand it the same way, so the auto-commit wrapper still commits and
  the hook no longer creates a literal `./~` directory in a project. `~user/…`, absolute and
  relative paths are unchanged by design.
  **Migration note:** if you already have data under a literal `~` directory from this
  bug, move it to the intended home path — `nb` will no longer look there.
- **Batch-vote partial selector-misses are no longer laundered out of `nb stats`' vote error causes (#310).**
  A batch vote (`nb vote <shelf> id1,id2,id3 +1`) that resolved at least one id but skipped others
  exited `0` and wrote a clean success row — no `errorClass` — so its stale ids were invisible to the
  `errorClass`-built vote selector-miss readout (#223), even though a *single* failed vote throws and
  gets a class stamped. The exact workflow batch vote was added for (#223/#224) thus under-reported the
  "agents voting on ids that no longer exist" signal that drives curation health. Each ≥1-landed batch
  row now records the count of skipped ids in a new trailing **`misses`** usage-log column (a dedicated
  counter, **not** `errorClass`, so the partial success keeps exit `0`), and `nb stats` folds those
  misses into the `vote` error causes as `no_match` — the same class a wholly-failed vote stamps —
  subject to the existing dominant-error noise floor. The per-command error **rate** is unchanged (it
  counts whole failed calls, so a batch that exited `0` stays a success there); the all-fail
  (`no_match`, exit 1) and single-vote paths are untouched. The column is appended last, so pre-#310
  rows read it as `0` and a corrupt negative cell is clamped to `0`; `STATS_SCHEMA_VERSION` stays `1`
  (additive). See [FR-STATS-008](docs/requirements.md#fr-stats-008).
- **Lowering `NB_MAX_LINES` below a full shelf now reports every eviction, not just one (#306).**
  When the cap is lowered under a full shelf's size, the next `add`/`merge`/`split`/`move` trims
  the shelf all the way down in one call — many evictions at once (e.g. `NB_MAX_LINES` 50→10 on a
  full shelf evicts 41). The result and the usage log's `evicted` column surfaced only the FIRST,
  so a data-loss event was under-reported to one entry and the `eviction-while-still-voted` signal
  that reads that column missed the scale. The result now carries an `evictedAll` array with every
  removed entry (`evicted` stays the first, so the single-eviction common case is byte-identical),
  the usage `evicted` column records a comma-separated `<id>:<score>` list bounded by `maxChars`
  with a count-preserving `+<dropped>` marker, the `added`/`moved` message appends `+N more lines`,
  and the still-voted signal counts each evicted entry. See
  [FR-USAGE-002](docs/requirements.md#fr-usage-002) and [FR-STATS-003](docs/requirements.md#fr-stats-003).
- **A CRLF-normalized notebook no longer loses its `# desc:` trigger (#273).** The project
  supports git-versioning and backing up the notebooks dir; on Windows with `core.autocrlf=true`
  (or any CRLF hand-edit) each `<shelf>.md` line arrives terminated by `\r\n`. The leading-metadata
  scan split on `\n` only, leaving a trailing `\r` that made `# desc: …\r` fail the `$`-anchored
  metadata pattern — so the description silently decayed into a score-0 lesson and the shelf lost
  its trigger. The scan now splits on `\r?\n`, so a CRLF notebook parses identically to an LF one:
  the description is preserved, a mutation rewrites the file with clean LF endings, and LF users are
  unaffected. See [FR-DESC-001](docs/requirements.md#fr-desc-001).
- **`nb` now refuses an unknown or misplaced `--flag` instead of silently ignoring it (#267).**
  A mistyped flag was dropped without a word — so `nb stats --exitcode >/dev/null || alert`
  (a typo of `--exit-code`) ran WITHOUT the health gate and still exited `0`, silently
  defeating the #129 cron monitor by one missing hyphen. Each command now validates its
  `--`-prefixed options against a bounded per-command set and fails fast on an unrecognized
  one with `unknown option "<flag>" for \`nb <cmd>\`` (exit `1`, message on stderr; the
  structured `{ok:false,…}` object on stdout under `--json`), appending a `Did you mean
  \`<nearest>\`?` hint when one is close. The `--` end-of-options terminator (#277) still
  shields a flag-shaped operand, a bare trailing `--` (vote's downvote alias) is untouched,
  and an unknown *command* keeps its exit-`2` path. See [FR-CLI-009](docs/requirements.md#fr-cli-009).
- **`nb-janitor` §4 no longer reports a git failure as "not a git repo" (#269).** `gitHistory()`
  returned `null` both when `NB_DIR` has no `.git` *and* when `git log` failed — its 5s timeout on
  a huge repo, git's dubious-ownership refusal on a shared host, a corrupt repo, or git missing
  from `PATH` — so section 4 printed the flatly-false "NB_DIR is not a git repo" guidance on a
  genuine git error. The two cases are now distinguished: a real failure prints "git history
  unavailable — git failed, timed out, or refused access …", while the absent-`.git` path keeps
  its unchanged "not a git repo" line. Read-only and zero-dependency, like the rest of the janitor.
- **`withLock` fails fast on an unwritable notebook store instead of busy-waiting (#263).** The
  lock-acquire loop treated *any* `mkdir(.nb.lock)` error as "lock held", so on a read-only or
  permission-denied `NB_DIR` every mutation spun the full acquire budget (~12s) and then died with
  a misleading `notebook is locked (…)` — when no other process existed and the real cause was an
  unwritable store. The loop now treats only `EEXIST` as a held lock and fails fast on any other
  code (`EACCES`/`EPERM`/`EROFS`/`ENOSPC`/…) with a clear `notebook directory is not writable`
  message, chaining the original error as the cause.
- **`--` now ends option parsing so a flag-shaped operand survives (#277).** `--json` was
  stripped from the *entire* argv, so recording a glossary line that is literally `--json`
  (`nb add flags "--json"`) dropped the operand and then threw `missing <lesson>` for the
  lesson the user plainly typed — and there was no way to escape it. `nb` now honors a
  POSIX `--` end-of-options terminator: every token after the first `--` is a literal
  operand, so `nb add flags -- --json` stores the line `--json`. `--json`/`--reason`/`--note`
  are recognized only before the `--`; a bare trailing `--` is still a literal operand, so
  `vote`'s `--` downvote alias is unchanged ([FR-CLI-007](docs/requirements.md)).
- **`nb-git-wrapper` no longer lets concurrent mutations race in its git section (#271).** The
  wrapper ran `git add -A` → commit with no lock of its own, *after* the package had released its
  `.nb.lock`. Under parallel-subagent workloads two wrappers interleaved: one `git add -A` staged
  a sibling's already-written `.md`, bundling two changes under one mislabelled commit while the
  other found nothing staged and dropped its commit (or the two git calls collided on
  `index.lock`). Two independent guards now fix this while keeping the lesson written *first*, as
  before: autoCommit stages **per change** (everything except `*.md`, then only the shelves this
  command wrote), so a sibling's concurrently-written shelf is never bundled in; and a per-`NB_DIR`
  `.nb-git.lock` mkdir lock (distinct from `.nb.lock`) serializes only the git calls, so they can't
  collide on `index.lock`. The lock is fail-open and guards no lesson write — a git or lock problem
  never fails or loses a lesson. One commit per change, with an accurate message.
- **`nb search` rejects a third operand and no longer logs a mistyped shelf prefix as a missing lesson (#402).** An unquoted two-word query (`nb search flaky test`) read the second word as a shelf prefix, reported no match although the lesson existed, and logged a false coverage gap. A third operand now exits 1 with `bad_args`, and a prefix that matches no shelf is logged with the outcome `no-shelf` instead of `no-match`.
- **`nb stats` says when `--since` reaches further back than the usage log retains (#406).** The usage log keeps a fixed number of rows, not a span of time, so on a busy store `--since 30d` can cover only the last few days. The report now adds a line `usage log reaches back only …` when the log is at its row cap and its oldest row is newer than the start of the window.
- **A stray `*.md` file with an invalid shelf name no longer breaks every cross-shelf command (#369).** A file such as `review copy.md` in the notebooks directory made `nb list`, `nb search` and `nb stats` exit 1 for every shelf. Those commands now skip the file and report it, and `nb doctor` lists it under the finding code `invalid-name`. Naming such a shelf directly is still a `bad_args` error.
- **Unicode Tag characters and the soft hyphen are stripped from lessons (#374).** These invisible characters (U+E0000–U+E007F and U+00AD) passed the earlier control-character filter (#335); they are now removed on write, and `nb doctor` flags a stored lesson that contains them.
- **`nb doctor` escapes file names read from disk (#410).** A file name containing an escape sequence reached the terminal as-is, and one containing a newline forged extra finding rows. The human output of `nb doctor`, and the "skipped file" lines that `nb list`, `nb search` and `nb stats` write to stderr, now show such characters as visible backslash escapes (for example `\u001b` for an escape character, or `\n` for a newline inside a quoted file name), so no raw control character reaches the terminal through that output. `--json` output is unchanged.
- **`nb stats` counts a batch vote once per lesson in the surfacing metrics (#373).** `nb vote <shelf> <id1,id2,…> +1` was counted as one vote, so the surfacing metrics were wrong for the voting form `nb show` recommends.
- **The `loop` and `went-silent` anomalies no longer fire on a healthy store (#372).** `loop` now groups calls by session, so several agents each making one call are not reported as one stuck agent, and `went-silent` ignores rows for a mistyped command name. This matters most to `nb stats --exit-code`, which exits 3 on any anomaly.
- **`nb stats` honors the `--` terminator (#302).** `nb stats -- --json` still printed JSON because `stats` re-read the raw arguments; it now uses the same option parsing as the other commands.
- **`nb add <shelf> -` no longer buffers all of stdin before checking it (#304).** It stops reading as soon as the input is multi-line, and rejects with `too_long` once a byte budget (8× the lesson cap, at least 4096 bytes) is exceeded.
- **A shelf file that starts with a UTF-8 byte-order mark is read correctly (#299).** The mark made the `# desc:` line unrecognizable, so the description was read as a lesson with score 0.
- **A shelf deleted by a concurrent `nb rm` while another call reads it is treated as empty (#300).** The reader used to crash when the file disappeared between its existence check and its read.
- **`nb move` and `nb describe <shelf> ""` no longer leave a 0-byte shelf file behind (#355).** Every mutation that empties a shelf with no description now removes the file, not only `nb rm` (#209). A shelf that still has a description is kept.
- **The store lock can no longer be released by, or granted to, the wrong process (#331).** A holder that ran longer than `NB_STALE_LOCK_MS` removed the lock of the process that had taken over from it, and two waiters racing for one stale lock could both acquire it. Each lock now carries an owner token that is checked on release, and takeovers of a stale lock are serialized.
- **Two writers that overlap after a lock takeover can no longer corrupt a shelf (#270).** Every writer used the same temporary file name for a shelf, so their bytes could interleave before the atomic rename. Each process now uses its own temporary file.
- **One usage-log row can no longer grow without bound (#292).** A `search` row recorded the id of every hit across every matching shelf. The id list is now capped like the other free-text columns, so the log's row limit also limits its size.
- **Concurrent calls on a full usage log no longer drop each other's rows (#377).** With a missing or stale row-count file, each overlapping call rewrote the whole log as soon as it reached its cap. Rewrites now wait for the same threshold on both code paths.
- **The package no longer ships source maps that point at files it does not contain (#316).** The maps referenced `src/*.ts`, which is not published. Source maps are no longer built, and a test checks the package's file list.
- **`examples/nb-janitor.mjs` suggests `nb move`, not re-adding, to fold a typo-split shelf (#408).** Re-adding resets every lesson's score to +1; `nb move` keeps it.
- **`examples/nb-janitor.mjs` warns when `--days` reaches further back than the usage log retains (#275).** The windowed sections used to print an all-clear computed from only the rows still in the log.
- **`examples/nb-git-wrapper.mjs` handles a closed pipe and signals like `nb` does (#401).** `nb show <shelf> | head` through the wrapper crashed with an `EPIPE` stack trace and exit 1.
- **`examples/hooks/claude-code/nb-session-start.sh` reports a failing `nb list` as a failure (#303).** It used to print "no notebooks yet" when `nb list` failed, and did not print it for a store that really was empty.
- **`examples/nb-backup.sh` and the git wrapper no longer collide on git's index lock (#305).** The backup's commit now takes the wrapper's `.nb-git.lock`; if the lock stays busy the commit is skipped and the push still runs.
- **`examples/nb-backup.sh` cannot hang forever on a credential prompt (#272).** `git push` now runs with prompts disabled and a timeout (`NB_BACKUP_PUSH_TIMEOUT`, default 300s). A hung push used to hold the single-instance lock, so every later run skipped.
- **`examples/nb-backup.sh` validates `NB_BACKUP_PUSH_TIMEOUT` (#311).** A malformed value such as `5min` made every push fail with a generic message; it now logs a `CONFIG ERROR` and uses the 300s default.
- **`examples/nb-backup.sh` names a missing git identity as the cause of a failed commit (#308).** On a host with no `user.name`/`user.email`, every commit failed with only "COMMIT FAILED — see log".
- **`examples/nb-backup.sh` is a no-op when there is nothing new to commit (#274).** Without a `.gitignore`, each run committed the log line the previous run had written. The script now seeds a `.gitignore` for its own log and lock files.

### Documentation

- **A project / domain / global memory-layer convention for agents that work across several repos (#363).**
  New [`docs/memory-layers.md`](docs/memory-layers.md) describes three layers read off the shelf name
  (`<situation>@<slug>`, a bare `<situation>`, one bare global shelf), "project beats domain beats global"
  as an instruction to the model, a "narrowest layer first, promote later with evidence" placement rule,
  promotion with `nb move` (what a full target shelf evicts, and how to check first), one slug per repo, and
  what `nb` deliberately does not do (no layer metadata, no `nb promote`, no scope filter). AGENTS.md section 4
  and the README docs list link to it. The example `nb-session-start.sh` gains an optional layered index,
  off unless `NB_PROJECT_SLUG` is set (`NB_GLOBAL_SHELF` names the global shelf); with it unset the hook
  behaves exactly as before. No `nb` command, output or file format changes.

## [0.7.0] - 2026-11-06

### Added
- **`nb stale <shelf>` lists cull candidates to revive the curation loop (#240).** The `#223`
  usage audit found the curation half of the design dormant: 572 upvotes vs 3 downvotes, and
  eviction only ever culls at the 50-line cap — so on a sub-cap shelf a wrong `+1` lesson
  persists forever. The new read-only `nb stale` command surfaces a shelf's lessons in the
  order eviction would drop them (lowest score first, ties → stalest), most disposable first,
  with a ready-to-run `nb vote … -1` / `nb rm …` footer so the retrospective acts by id. It
  takes `--limit N` (default 10) and `--json` (a `StaleResult`), and never changes a score,
  reorders, or removes anything. ([FR-SHOW-003](docs/requirements.md).)
- **A too-long `add` now reports the overflow so re-drafts stop guessing (#239).** The `#223`
  usage audit found `add` wastes ~1 in 3 calls on the 200-char cap, and each rejected lesson
  is re-drafted blind because the error named the length and the cap but never how far *over*
  it was. The rejection now reports the overflow (`length - maxChars`): the human message reads
  `… N over the <cap> limit — trim at least N …`, and `nb add --json` carries an additive
  `overflow` field alongside the existing `length`. Behaviour is unchanged — a too-long add
  still exits 1 and is never stored or truncated ([FR-ADD-004](docs/requirements.md)).
- **`nb stats` reports the usage ring's own occupancy (#206).** The stats report showed
  per-shelf notebook cap pressure (#40) but never how full the monitoring log itself is. A new
  `usageRing: { rows, cap }` field (and a human `usage ring: <rows>/<cap> rows` line, flagged
  `FULL` at the cap) surfaces total on-disk row count vs the `NB_USAGE_RING` bound, so an
  operator can see the log is near compaction and about to drop the oldest history. It is total
  occupancy — independent of the `--since` window, unlike `totalCalls` — and read from the ring
  scan the report already does (no extra read). Additive: `STATS_SCHEMA_VERSION` is unchanged.

### Fixed
- **An emptied, undescribed shelf no longer leaves a 0-byte `<shelf>.md` on disk (#209).**
  When `rm` removed the last lesson from a shelf with no description, the file was rewritten as
  an empty string: `nb list` hid it, but nothing ever removed it, so phantom 0-byte files
  accumulated in the notebooks dir, every backup, and git history without bound. Such a truly
  empty file is now reaped (unlinked) under the mutation's lock. A described-but-empty shelf
  (a `# desc:` trigger with no lessons) is non-empty and is preserved.
- **The usage-log `session` column is now length-capped like `note` (#202).** `NB_SESSION`
  was written to every row with sanitization but no length cap, so a long session id (a full
  task path, a chained id) multiplied the on-disk log size across the whole ring — defeating
  the row-count bound the ring exists to enforce (the same failure #128's note cap prevents). A
  session longer than `maxChars` is now truncated (same trailing-ellipsis convention as `note`,
  never rejected — logging stays best-effort); a normal short session round-trips unchanged.
- **`nb --help` and `nb --version` now append a usage row (#250).** Both returned before the
  shared usage-logging step, so they left no trace in the usage ring — the module's "every call
  appends one line" invariant was false, and `nb stats` was blind to the classic
  integration-not-wired symptom of a harness that only ever runs `nb --help` and never a real
  command. Each now writes a lightweight best-effort row under the canonical command `help` /
  `version` (every alias — `-h`, `-v`, no-args, bare `help`/`version` — aggregates under one
  name). Logging stays best-effort, so `--help`/`--version` still succeed on a read-only
  `NB_DIR` ([FR-USAGE-001](docs/requirements.md)).

## [0.6.0] - 2026-11-06

### Changed
- **`nb-janitor` §5 co-access now tells a `fragment` from a `panel` (#223).** A high-co-access pair used
  to always advise "merge/namespace", which is wrong for distinct roles that *legitimately* co-fire — an
  RFC review panel, or an orchestrator with its per-project reviewers. Each pair is now classified: a
  `fragment` (same project scope AND a near-identical role name or shared `.`-stem — one role split in two)
  keeps the merge/namespace advice; a `panel` (different roles) is labelled "expected; extract a shared
  umbrella shelf only if they carry duplicated cross-cutting lessons, don't merge the roles". Fragments
  sort ahead of panels so a genuine split never hides behind an expected panel. `highPairs[].kind` is added
  to `--json`.

### Added
- **`nb-janitor` sections 6 & 7: curation and undescribed-shelf signals (#223).** The usage audit
  surfaced two kinds of debt the offline janitor now reports. **§6 Curation** prints the window's
  upvotes vs downvotes (the audit found voting is almost entirely upvotes, so a wrong lesson only
  leaves when its shelf fills) and lists shelves dominated by a large pile of never-reinforced
  `+1`-floor lessons to scan for ones that misfired (`nb show` → downvote/rm). Shelf-level by design:
  the janitor has no per-lesson id to date a single line. **§7 Undescribed shelves** lists shelves
  with no explicit `# desc:` trigger, ranked by *browse-without-use* count (shown in a session but
  nothing in them voted) so the noisiest over-promisers get a real trigger first (`nb describe`); the
  browse ranking needs `NB_SESSION`, degrading to an alphabetical list without it. Both appear in
  `--json` as `curation` and `undescribed`. Read-only and zero-dependency, like the rest of the janitor.
- **`nb stats` surfaces per-command error causes in the header (#223).** The per-command table shows
  each command's error *rate*; a new `error causes:` block names the *cause* so the two most actionable
  rates — `add` over-the-cap rejections and `vote` selector-resolution failures — are visible up front
  instead of buried behind the high-error-rate anomaly threshold. Each cause is an `errorClass` token
  (#176); a row predating that column falls back to its `outcome` (so `add`'s `too-long` still shows on
  an older log) and otherwise reads `unclassified` with a one-line cue to upgrade `nb`. Only commands
  with at least a handful of errors are listed. Exposed in `--json` as the additive `StatsReport.errorCauses`
  (`{ command, errors, breakdown: [{ cause, pct }] }`); no schema bump (purely additive).
- **`nb show` prints a copy-paste vote hint with the shelf filled in (#223).**
  The usage audit found ~1 in 5 votes failing on a fuzzy *text* selector even though the stable id
  was printed on the same line. `nb show <shelf>` now ends (when it has lessons) with a `#` comment
  line — `# vote by id: nb vote <shelf> <id> +1|-1  ·  several at once: nb vote <shelf> <id1,id2,…> +1`
  — so the reflect step votes by the id above (and can batch) instead of by an ambiguous substring.
  Display-only: it is never written to the file, never parsed back as a lesson, and is suppressed
  under `--json` (which stays a lone `ShowResult`) and on an empty/never-created notebook.
- **`nb vote <shelf> <id1,id2,…> +1|-1` votes several entries in one call (#223).**
  The end-of-session retro routinely promotes or demotes a handful of lessons at once; until now
  that was N separate `nb vote` calls — N round-trips, N chances for a stale/ambiguous selector to
  fail, N usage rows. A comma-separated list of **≥2 bare hex ids** (the ids `nb show` prints) now
  applies one delta to all of them under a single lock and a single write. It is batch **only** for
  an id list: a single token, or any comma-part that is not a bare hex id, stays one (possibly text)
  selector, so `nb vote s "build, then test" +1` is unchanged — batch-by-fuzzy-text would reintroduce
  exactly the ambiguity the id selector exists to avoid. Best-effort: each id resolves independently,
  an unresolved one is reported on stderr **without** aborting the rest, and the call exits non-zero
  only when *none* landed. `--json` emits the per-id result array (`{selector,id,text,score}` or
  `{selector,error}`). Library: `voteMany(dir, shelf, selectors, delta)`. A batch is **one logged
  action**: it writes a single usage row whose `entries` column lists every touched id (an all-fail
  batch logs a blank outcome, exactly like a single failed vote, so `nb stats` never counts a
  phantom upvote or marks a session engaged when nothing landed).
- **`nb config` prints the effective (post-clamp) `NB_*` tunables (FR-CONFIG-001 / #188).**
  Every knob is read at call time and *clamped* to its range, so the value `nb` actually runs
  under is not always the one you exported; there was no command that surfaced it, so when behavior
  looked wrong (a cap evicting too hard, a loop detector firing early, a near-dup over-warning) an
  operator had to re-derive the effective value by hand from the env var, its default, and its
  clamp. `nb config` now prints each effective tunable as `name=value` — the caps, near-dup
  threshold, usage ring + derived slack, lock timings, and the `nb stats` anomaly/readout
  thresholds — each read from the **same exported getter the hot path uses**, so a printed value
  can never drift from the value in force. Each line is tagged with its source: `(default)` (var
  unset), `(env NB_*)` (var set — the printed value is still the post-clamp effective one, so an
  out-of-range or non-numeric value shows up corrected, never silently misrepresented, DP-5), or
  `(derived …)`. `nb config --json` emits one object keyed by tunable name, each `{ value, source,
  env }`. Read-only (it mutates nothing) and scoped to *configuration*, deliberately distinct from
  `nb stats` (usage, anomalies, engagement). To surface the `nb stats` thresholds without copying
  their clamp logic into a second place (the #116-class drift the #131 guard guards against), the
  inline threshold constants in `stats()` were extracted into exported getters
  (`loopN`/`loopWindowSec`/`silentHours`/`errMin`/`errRate`/`coverageHi`/`recallMissHi`) that
  `stats()` now calls — a behavior-preserving refactor (same defaults, same clamps). `config` is
  added to `KNOWN_COMMANDS`/HELP/dispatch so the drift guard stays green and shell completion
  learns it.
- **`nb search --limit N` bounds results like `nb list` (FR-SEARCH-001 / #186).** `nb list`
  takes `--limit` (default 50) so the index stays flat as notebooks grow, but `nb search` had no
  result bound — a common term (or `--any`) on a many-shelf deployment dumped every matching
  notebook's hits to stdout, the exact "discovery cost grows with the corpus" problem. `search()`
  now takes an optional `limit` that bounds the returned notebook **groups** after ranking, and the
  `search` CLI case parses `--limit` with the same forgiving semantics as `list` (a bad value warns
  on stderr and falls back to the default `50`); the human header then reads `N of total notebooks`.
  The bound shapes only what is returned/printed: `SearchResult` now also carries `total` (the full
  pre-limit match count) and `surfacedIds` (every id surfaced across the full result), and the
  `failed-search` gap-sensor outcome and the `#114` surfacing provenance are computed on that full
  result — so a small `--limit` (even `0`) can never turn a real `match` into a `no-match` coverage
  gap. `--json` reflects the bounded `groups` plus the two full-result fields.
- **`nb path --usage` prints the resolved usage-log path (FR-PATH-001 / #169).** `nb path`
  exposed the notebooks dir and `<shelf>.md` paths but nothing printed the usage-log path, so a
  supervisor had to hard-code `$NB_DIR/.nb-usage.log` to tail or back it up — the same coupling
  `nb path` was added (#14) to remove, which would break silently if the internal filename ever
  changed. `nb path --usage` now prints `<NB_DIR>/.nb-usage.log` as a bare path (pipe-friendly,
  no decoration), and `usageFile(dir)` is exported for programmatic use. `--usage` is the only
  recognized flag; any other `--`-prefixed token is rejected by the safe-shelf check, so it can
  never collide with a shelf name. (Tail with `tail -F`: the log is a self-compacting ring
  replaced by write-then-rename, so a `-f` tail on the old inode would go stale.)
- **Serendipity surfacing provenance (`serendipity` in `nb stats`, FR-STATS-004 / #114).**
  `serendipity` was defined (`relevant ∧ arrived-unbidden`) but not measurable: the log carried
  no surfacing provenance, so an upvote could not be told apart as push- vs pull-delivered.
  `nb search` now logs the entry ids it surfaced (reusing the `entries` column — no new column),
  so within a session an upvote on a searched entry reads back as a *pull* and one no search
  returned as a candidate *push*. `nb stats` reports `serendipity` = push-delivered upvotes ÷
  `upvotes` (both exposed in `--json`), beside recall-miss/precision-miss. Pull evidence is read
  deployment-wide, so a shelf-scoped report still sees the cross-notebook search. It is published
  as a two-sided inferred **proxy, not a bound** (a `show`-pull/recall inflates it; a same-session
  search match deflates it) and the human line flags it with a leading `~`. The positive push
  record — tagging the session-start injection hook's own read — is a cross-repo follow-up under
  the #73 injection contract (see RFC 0114). The `[loop]` anomaly still treats a `search` as
  entry-less, so hammering `search` with varying queries is still flagged.
- **Non-blocking near-duplicate advisory on `nb add` (FR-ADD-008).** The exact-normal-form
  dedup key misses paraphrases (`"run lint before done"` vs `"lint before claiming complete"`),
  so a re-derived lesson is silently re-stored and the recall-miss goes uncounted. An accepted
  add now also compares the lesson to existing entries with a deterministic, dependency-free
  trigram-Jaccard `similarity`; when one is at/above `NB_NEAR_DUP` (default `0.5`) it still
  stores the lesson (never blocks — a fuzzy match must not cause a silent loss, DP-5) and
  prints a `nb merge` suggestion to stderr (stdout stays pipe-clean; `--json` carries `nearId`).
  The resembling id is logged in the `collided` column of the still-`accepted` row, making the
  near-duplicate / paraphrase-miss rate measurable. No embeddings, no new runtime dependency
  (NG-001 amended to permit a non-blocking lexical advisory while the *blocking* decision stays
  exact-normal-form only).

### Fixed
- **A `vote`/`rm`/`split`/`move` on a never-created shelf now reads as a typo, not an empty
  notebook (FR-CLI-006 / #200).** These commands threw `notebook for shelf "X" is empty` for a
  shelf that was *never created*, mislabeling a mistyped name as a real-but-empty notebook — so an
  agent would seed a brand-new lesson onto the wrong (nonexistent) shelf instead of correcting the
  name, silently fragmenting memory across typo shelves. The CLI now checks existence first (as
  `nb show` has since #166) and reports `no notebook for shelf "X"`, appending an advisory `did you
  mean "<nearest>"?` when a close existing shelf is found — the shelf sibling of the command
  did-you-mean (#171), over the same `editDistance`. An *existing but empty* shelf still reports
  `is empty`; the hint never auto-corrects; and the core mutation functions are unchanged. For
  `move`, only the source is guarded — a never-created target is still created like `add`.

### Documentation
- **Retrospective contract now steers `vote` to the id, not a text snippet.** `nb stats` showed
  `vote` erroring on ~22% of 325 calls, and dozens of `browse-without-use` sessions (a shelf shown
  but never voted) — because the injected contract advertised "a unique snippet of the lesson text
  works too" as an equal to the id, and a *non-unique* snippet is refused (`notebook.ts` lists the
  candidate ids). The `AGENTS.md` §④ retrospective step and the Codex `AGENTS.snippet.md` now tell
  the agent to vote by the `<id>` `nb show` already prints at each line start (with a worked example),
  and frame a text substring as refused-if-ambiguous rather than a casual equal — removing the
  invitation to the error path that was also suppressing the end-of-task retrospective.
- **README recentered on the developer audience, with the compounding payoff stated plainly (#139).**
  The top of the README now opens with a one-line *who this is for* (developers who run AI agents and
  want them to carry a few durable lessons across runs) and a plain payoff sentence (the agent remembers
  hard-won lessons, avoids repeating mistakes, and improves over the experience it has chosen to keep — voted by
  usefulness, bounded in size), instead of describing the tool mostly by what it is not. `nb --help` now
  echoes the same one-line description so the framing is consistent in-product.

## [0.5.0] - 2026-10-31

### Fixed
- **`nb stats` no longer mistakes a retrospective sweep for a stuck loop.** The `[loop]`
  anomaly ("N+ calls within the window — the agent may be stuck/looping") keyed only on
  shelf + command, so a healthy retrospective that rapidly votes many *distinct* lessons in
  one session tripped it. The loop key now includes the touched entry id(s), so repeating the
  *same* targeted call (or a repeated entry-less call like `show <shelf>`) still trips it while
  a sweep across distinct entries does not.
- **`nb-janitor` shelf-name dedup (section 2) is now `@project`-scope-aware.** A shelf name is
  `role@project` (and the role may use the `.`-namespace convention). The old check ran
  edit-similarity across the whole name with only a `.`-stem suppression, so a long shared
  `@project` suffix inflated the score and flagged `orchestrator@proj` vs `patch-author@proj`
  — different roles in the *same* project — as "likely the same shelf split in two." It now
  compares similarity on the *role*, only within the same project scope, while still suppressing
  intentional `.`-namespace siblings (`build.ci` vs `build.cd`, which the role comparison alone
  would wrongly flag). Genuine same-scope typo fragmentation (e.g. `code-review` vs
  `code-reviews`) is still caught.

### Added
- **"Diagnosing low engagement" runbook** (issue #108). [`docs/harness-setup.md`](docs/harness-setup.md#diagnosing-low-engagement)
  gains a troubleshooting section for the *ongoing* symptom the old "Verify it's working" smoke
  test never covered — "my agents don't seem to use the notebooks." It centers on the failure mode
  that is otherwise silent: the SessionStart injection hook **fails open**, so a mis-wired hook
  errors nothing and tells no one. A symptom→cause→remedy decision tree reads the deployment-wide
  `nb stats` `surfacing:` line (the no-argument form — the engagement diagnosis is computed across
  all shelves regardless of any shelf argument, so the no-arg view is the one that also prints the
  full inventory) and maps each of the three #105 root causes to its concrete
  fix: hook-not-wired → a copy-paste **hook self-check** (`bash examples/hooks/claude-code/nb-session-start.sh | head`;
  empty ⇒ broken), reads-but-no-votes → wire the retrospective hook, blank sessions → export
  `NB_SESSION` — plus a fourth "engaged, not a bug" row for genuine quiet. Linked from the README.
  Docs-only; no code, no notebook-file schema change.
- **nb-janitor reports shelf co-access** (issue #107). The offline, read-only janitor
  (`examples/nb-janitor.mjs`) gains **section 5**: it groups usage rows by session, collects
  the set of shelves `show`n per session, and counts shelf-pair co-occurrence — the one signal
  the shelf definition rests on (lessons needed *in the same situations*) that nothing measured
  before. It reports **high-co-access pairs** ("almost always opened together → consider one
  namespaced shelf or `nb merge`", when a pair's `co ≥ 2` and `co / min(shows) ≥ 0.8`) and
  **isolated shelves** (shown but never alongside another). Blank-`NB_SESSION` logs degrade to a
  one-line "set NB_SESSION" note, exactly as section 4 degrades without git. The data is added to
  `--json` as `report.coAccess` (`{ computed, sessions, highPairs, isolated }`). Read-only, hot
  `nb` path untouched (DP-6), zero dependencies, no notebook-file schema change. See
  [RFC 0107](docs/rfcs/0107-janitor-shelf-co-access.md).
- **`nb stats` shows an ops-per-day activity sparkline** (issue #106). The report gains a
  one-line, zero-dependency Unicode block-glyph plot of activity over the window —
  e.g. `activity  ▂▁▅█▇▃▁  (7d, 41 ops)` — so "when did this store go quiet?" is answerable
  at a glance instead of by eyeballing raw `.nb-usage.log` timestamps. Rows are bucketed
  into **rolling 24-hour windows counting back from now** (timezone-free; oldest bucket
  leftmost, the 24h ending now rightmost), and the per-bucket counts are exposed as
  `StatsReport.activity` in `nb stats --json` (`sum(activity) === totalCalls`). Scaling is
  zero-based so a silent (0-op) bucket always reads as the floor glyph `▁`. No notebook-file
  schema change and no new runtime dependency; the library gains the pure `sparkline` and
  `activityByDay` functions. See [RFC 0106](docs/rfcs/0106-stats-activity-sparkline.md).
- **`nb stats` breaks down "no engaged sessions" by root cause** (issue #105). When the
  engagement gate finds no engagement anywhere in the window, the one vague
  `surfacing: no engaged sessions…` line is replaced by up to three terse, actionable
  lines naming the actual deployment-level failure(s): `NB_SESSION` unset (calls can't be
  grouped into sessions), the retrospective nudge not landing (a notebook was opened but
  never voted), or the SessionStart injection hook not wired (notebooks hold lessons but
  nothing read them). The diagnosis is deployment-wide — the hook's own global `nb list`
  is counted as a read but **not** as deliberate engagement, so it is never
  double-counted — and the underlying counts are exposed as
  `surfacing.engagementDiagnosis` in `nb stats --json` (`null` whenever any session was
  engaged). No notebook-file schema change; the library gains the `diagnoseEngagement`
  function and the `EngagementDiagnosis` type.
- **`nb move <from> <to> <id|query>` — score-preserving cross-shelf move** (issue #103).
  Relocates one lesson from one shelf to another **with its score intact**, the
  consolidation `add`+`rm` could not express (`add` always enters at the `+1` floor, so a
  hard-won lesson would land at the bottom of the target and lose its vote history). The
  entry is admitted into the target like a newcomer, so a full target ages/evicts its
  stalest *other* line, never the lesson just moved. The move is refused — writing nothing
  to either shelf — when the source and target are the same shelf, the selector is
  absent/ambiguous (same unique-match rule as `vote`/`rm`), or the target already holds a
  near-duplicate (same dedup rule as `add`). Accepts the usual `--reason <code>`/`--note`
  (enum: `consolidate` · `other`) and `--json` (emits a `MoveResult`). The library gains
  `move(dir, fromShelf, toShelf, selector)` and the `MoveResult` type.

## [0.4.0] - 2026-10-29

### Changed
- **Terminology: a notebook file is now called a *shelf*.** A shelf is one `<name>.md`
  notebook file: a group of lessons an agent needs in the same situations. Lessons are
  grouped by co-access (needed together), not by agent role, so an agent that opens a
  shelf can get the lessons it looks for plus ones it might not think to search for. The CLI help, error messages (e.g.
  `invalid shelf name`, `missing <shelf> argument`), human `nb stats` output, README,
  AGENTS.md and docs now say shelf. Argument positions, the `shelf@project` scoping, every
  `NB_*` variable, the file layout and the usage-log format are unchanged.

- The `.` namespace convention now recommends **no prefix or one level at most**
  (`family.situation`). The dot builds no hierarchy, and deeper names split lessons that
  are needed together into small shelves. Docs only; no behaviour change.

- **A full shelf is the normal state; do not split a shelf because it is full.** Eviction
  and aging only run at the cap, and they are what retire unused lessons; splitting on
  size multiplies half-empty shelves and makes the index harder to choose from. The README
  gains a section on when to act: only when a full shelf keeps evicting lessons still
  scored above the starting +1, or relearns evicted ones. The `eviction-while-still-voted` signal of `nb stats`
  now counts only lessons evicted with a score above the +1 a new lesson starts at (evicting
  a lesson that was never voted, or that fell back to +1 or below, is the cap working),
  and its detail no longer suggests splitting.
- `examples/nb-janitor.mjs`: section 1 is now "Lessons lost to eviction". It flags a shelf
  with 2 or more evictions of lessons scored above +1 or re-added evicted lessons in the window, and
  reports how many shelves are full for information only. The `--json` report replaces
  `capPressure` with `fullShelves` and `lostLessons`.

### Added
- `shelf` key next to `role` (same value) on every JSON object that carried `role`:
  `nb show --json`, `nb list --json` rows, `nb search --json` groups, `nb describe --json`,
  and in `nb stats --json` the `notebooks[]`, `anomalies[]` and `signals[]` entries.
  `notebookTotals` gains `shelves` next to `roles`.
- Library exports `listShelves` and `assertSafeShelf`, and a `shelf` option for `stats()` (the `role` option still works).
- `nb shelves`, an alias of `nb list`.

### Deprecated
- The `role` / `roles` JSON keys, the `listRoles` and `assertSafeRole` exports, the `role`
  option of `stats()`, and the `nb roles` command. They still work and behave exactly as before; they will be removed
  only in a later release marked BREAKING.

## [0.3.0] - 2026-10-29

### Changed
- **Eviction is now recency-aware, and a full notebook always admits a newcomer.**
  Storage order became *recency* order (least-recently-touched first): a touch — a vote
  of either sign, an add, or a merge/split's new lesson — moves its entry to the end of
  the file. When a full notebook takes a new lesson it is always stored (the old
  `rejected-full` outcome is gone); the lowest-scored line is evicted (ties → stalest) and
  then the stalest *surviving* line is docked one point. That gentle, targeted "aging" is
  what lets a once-upvoted lesson that has gone quiet eventually fall, instead of being
  immortal, without needing a downvote to arrive. It fires only when a notebook is full, so
  every sub-cap notebook is unaffected except that a vote now moves its line (a ~2-line git
  diff instead of a 1-line one). Rationale and the full design in `docs/eviction-and-aging.md`;
  this reverses the old DP-3 "storage is insertion order, never reordered on vote".
- The default per-notebook cap (`NB_MAX_LINES`) is now **50**, down from 200. A tighter
  default keeps eviction pressure meaningful and a notebook focused on the lessons that
  earn their place; most roles need far fewer than 200. Raise it any time with
  `NB_MAX_LINES` (range unchanged, 1–5000). The character cap (`NB_MAX_CHARS`) stays 200.

### Added
- Onboarding and harness-integration documentation (docs-only; no package behaviour change).
  - `AGENTS.md` (with `CLAUDE.md` as a symlink to it) — the agent operating contract: the
    four moments (list / open / subagent / retrospective) and how to write a lesson. The
    core behaviour is harness-agnostic: the agent lists the notebooks and opens the ones
    that fit, rather than a role-specific notebook being auto-injected.
  - `docs/getting-started.md` (plain-language intro with diagrams), `docs/harness-setup.md`
    (make Claude Code / Codex CLI use it on Linux/macOS/Windows via the list-&-open
    instruction, plus optional convenience hooks, git-versioning, backup, janitor),
    `docs/enterprise.md` (data-sovereignty / security / compliance rollout), and
    `docs/visual-explainer.html`.
  - `examples/` — the optional harness layer: `nb-git-wrapper.mjs` (a commit per change),
    `nb-backup.sh` (daily push), `nb-janitor.mjs` (read-only cross-notebook diagnostics:
    paraphrase-duplicate and near-duplicate-role detection, cap pressure, growth trends),
    and hook recipes for Claude Code and Codex CLI.
  - `.claude/skills/` — `agent-notebook-setup` and `agent-notebook-explain` skills that
    walk a user through configuration or explain the tool on request.

## [0.2.1] - 2026-10-28

### Added
- `nb show <role> --json` (#87) emits the notebook as `{ role, description, entries: [{ id, score, text }] }`,
  in the same order and with the same ids as the human output, so agents no longer parse text. The flag works
  before or after the role; the human output is unchanged. Library form: `showJson(dir, role)`.

### Fixed
- `nb describe` now strips the optional `--reason`/`--note` flags before reading its
  text operand, like the other mutating commands (#91). Previously an option placed
  before the text (`nb describe <role> --reason other "real text"`) was silently stored
  as the description and the intended text dropped, exiting 0 — a DP-5 violation. The
  flags are now logged to the usage log (never the notebook); `describe` has no seeded
  enum, so a stray code buckets to `other` with its text kept in the note, like `add`.
- A `README.md` in `NB_DIR` is no longer treated as a notebook (#90). A README is
  common when the notebook folder is a git repo that backs up your notebooks; it was
  being listed, searched, counted in `nb stats`, and — worst — voteable/removable,
  letting a write command rewrite it. `README.md` (case-insensitive) is now excluded
  from `listRoles` and the `README` role name is reserved in `assertSafeRole`, so no
  read or write command touches it. Documented beside the `.` namespace convention.

## [0.2.0] - 2026-10-28

### Added
- The **`.` namespace convention** for grouping notebooks (#83) — a documented,
  recommended way to cluster related notebooks by a `.`-delimited role-name prefix
  (`review.tests`, `review.correctness`) so they sort together and `nb list review.` /
  `nb search "flaky" review.` scope straight to the group. It is a **naming convention
  only**: a namespaced role is a first-class role (no change to `assertSafeRole` — `.`
  was already a legal interior character) stored as one flat `<role>.md` file, never a
  directory, and grouped lexically with no embeddings or similarity ([NG-001]). Keep the
  trailing dot so `review.` does not also match a bare `reviewer`; `@` stays reserved for
  the existing `role@project` scoping and composes with a namespace
  (`review.tests@repo`). Documented in the README and as [FR-NAMESPACE-001]; part of
  epic #73 (Phase 2).
- `nb search <query> [prefix] [--any]` (#82) — a **demoted, secondary** keyword fallback
  and gap-sensor. The primary path is *surfacing* (injection + the `nb list` index), per
  [DP-8] / [NG-007]; search exists only for genuine known-item lookup, and both the help
  text and the output say so plainly. It is **keyword-only** (plain case-insensitive
  substring over the query's terms — no embeddings, [NG-001]): it scans every notebook's
  lessons and descriptions, AND-over-terms by default (`--any` for OR), groups hits by
  notebook most-relevant-first, and prints each lesson's id so the agent can `vote` it.
  `--json` emits the raw `SearchResult`; the library form is `search(dir, query, {prefix?, any?})`.
  A search that finds nothing is logged (outcome `no-match`, query in the usage note) and is
  not an error (exit 0). That unlocks the **`failed-search → add` coverage-gap signal**
  deferred from #72: `nb stats` now derives a fourth `DiagnosticSignal` kind, `failed-search`,
  when a `no-match` search is followed by an accepted `add` in the same session — a gap the
  notebook did not hold, labelled by the agent's own query.
- Named **surfacing metrics** in `nb stats` (#81). `StatsReport.surfacing`
  (`SurfacingMetrics`) turns the usage ring into the rates the design rationale §4
  defines: **coverage** (novel-add rate = accepted ÷ attempts), **recall-miss** (the
  headline alarm — dedup-block rate = blocked ÷ attempts, a stored lesson re-derived),
  **precision-miss** (downvotes ÷ votes on pushed lessons, read beside recall so
  "surface everything" can't look free), and a coverage×surfacing **readout**
  (`healthy` / `surfacing-failure` / `coverage-building` / `churny`). Every rate is
  conditioned on *attempts* (robust to a lazy agent) and gated on *engagement* — only
  sessions with a vote are scored, so an uninstrumented session isn't read as "healthy
  quiet"; a rate with no data is `null` (shown `—`), never a misleading `0`. Surfaces in
  the human table under a `surfacing:` section and in `--json` as `StatsReport.surfacing`.
  Readout cutoffs are tunable via `NB_COVERAGE_HI` (default `0.5`) and `NB_RECALL_MISS_HI`
  (default `0.2`). Needs `NB_SESSION` set to attribute calls to sessions.
- `docs/self-observing-notebook.md` — the design rationale for the self-observing
  signal layer: why the tool instruments itself, what each operation signals, and how
  engagement, coverage, surfacing recall, surfacing precision, and serendipity are
  distinguished. Linked from `docs/requirements.md`.
- Free diagnostic signals in `nb stats` (#72). Three memory-quality observations read
  straight from the usage ring — no new agent action, no field added to a lesson: 
  **browse-without-use** (a notebook `show`n in a session with no `vote` on it that
  session → its description may over-promise), **eviction-while-still-voted** (the cap
  evicted an entry that had been voted on → the cap may be too tight for that role), and
  **vote-reversal** (the same entry upvoted in one session and downvoted in another →
  correct but mis-aimed). They surface in the human table under a `signals:` section and
  in `--json` as `StatsReport.signals` (`DiagnosticSignal = { kind, role, detail,
  session?, entry? }`), computed over the same windowed, role-scoped rows as the
  anomalies. browse-without-use and vote-reversal are session-scoped, so set `NB_SESSION`.
  The `failed-search→add` coverage signal is deferred to the future `nb search` command.
- `nb list` — the notebook index (#71). One richest-first line per notebook — name,
  lesson count, and description — so an agent can decide *which* notebook to open
  without reading any of them (level 1 of progressive disclosure for epic #73). `ls`
  and `roles` are aliases. Ordered by lesson count (ties by name); a notebook with no
  `# desc:` falls back to its top-scored lesson, marked `(auto)`. A bare `prefix`
  filters by name (the `.` namespace convention, e.g. `nb list review.`), `--limit N`
  bounds the rows (default 50; the header then reads "shown of total") so discovery
  cost stays flat, and `--json` emits the raw `NotebookListing`. An empty (zero-lesson,
  no-description) notebook is hidden as phantom debris; a described-but-empty notebook
  is kept. New library export `listNotebooks(dir, {prefix?, limit?})`.
- Notebook descriptions: `# key: value` metadata + `nb describe` (#70). A notebook file
  may now begin with a leading `# key: value` comment block; `readEntries` skips it (a
  `#`-leading `key:` line never becomes a score-0 lesson) and every mutation round-trips
  it. `nb describe <role> "<text>"` sets the notebook's one-line description — a *trigger*
  for when to open it — stored as a `# desc:` line; `nb describe <role>` prints it, an
  empty text clears it, and `nb show` prints it as a header. The description is capped
  like a lesson (rejected, not truncated), and unknown keys are preserved verbatim
  (forward-compatible). Stays within the no-schema non-goal — metadata is optional
  comment lines in the file, not a field on a lesson. Level 1 of discovery for epic #73.
- Entry-level + outcome logging in the usage ring (#67). Each `.nb-usage.log` row now
  also records the entry id(s) a call touched, a session id from the `NB_SESSION`
  environment variable, and the call's outcome (`accepted`/`dedup-blocked` with the
  colliding id, vote direction, eviction). The parser tolerates old five-column rows,
  logging stays best-effort, and the ring stays bounded — no field is added to a
  lesson. Foundation for the self-observing-notebook diagnostics (epic #73).
- This changelog.
- **DP-8 / NG-007** in `docs/requirements.md`, and a matching line in the README:
  memory's job is to surface the lesson an agent would not think to search for, so
  the notebook is *shown* (injected) rather than queried — a search-first retrieval
  model is a non-goal.
- `docs/requirements.md` — a canonical specification of the essential
  features, design choices, and their rationale (including why the on-disk
  file is stored in insertion order rather than sorted), so settled decisions
  are not re-litigated or mistaken for bugs.
- A pull-request template (`.github/PULL_REQUEST_TEMPLATE.md`) with a checklist
  item that keeps `docs/requirements.md` in sync with code changes.

### Changed
- `nb roles` is now an alias of `nb list` (#71): instead of a bare sorted list of role
  stems, it prints the richest-first index (header + one `name  count  description` row
  per notebook). Use `nb list --json` or the `listRoles` library function for the plain
  sorted stems. (This matches the richer format the kookr `nb` shim already provided.)
- The README now documents the `nb stats` anomaly-tuning environment variables (#8).
- The README now has animated SVG explainers (#13).

### Fixed
- `nb --version` now prints the real package version instead of a placeholder (#9).
- `nb stats --since` now warns about an invalid value (e.g. `--since banana`) instead of silently falling back to the full history (#11).

## [0.1.3] - 2026-10-23

### Fixed
- A fresh `npm run build` now produces an executable `nb`, and the build no longer depends on `@types/node` resolving indirectly.

## 0.1.2 - 2026-10-23

### Changed
- Version bump; no user-facing changes.

## 0.1.1 - 2026-10-23

### Changed
- Releases are now published to npm from CI using short-lived OIDC credentials (npm Trusted Publishing, with provenance) instead of a stored token. No change to the installed package.

### Fixed
- `nb` silently did nothing when run through an npm bin symlink; it now runs normally.

## 0.1.0 - 2026-10-23

### Added
- Initial release: a bounded, voted, plain-text memory for AI agents. Commands: `nb add`, `show`, `vote`, `merge`, `rm`, `stats`. Each role's notebook holds at most 200 lines, each at most 200 characters, and the lowest-scored line is evicted first when full. The library has zero runtime dependencies.

[Unreleased]: https://github.com/jeanibarz/agent-notebook/compare/v0.13.0-beta.2...HEAD
[0.13.0-beta.2]: https://github.com/jeanibarz/agent-notebook/compare/v0.13.0-beta.1...v0.13.0-beta.2
[0.13.0-beta.1]: https://github.com/jeanibarz/agent-notebook/compare/v0.12.0...v0.13.0-beta.1
[0.12.0]: https://github.com/jeanibarz/agent-notebook/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/jeanibarz/agent-notebook/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/jeanibarz/agent-notebook/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/jeanibarz/agent-notebook/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/jeanibarz/agent-notebook/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/jeanibarz/agent-notebook/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/jeanibarz/agent-notebook/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/jeanibarz/agent-notebook/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/jeanibarz/agent-notebook/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/jeanibarz/agent-notebook/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/jeanibarz/agent-notebook/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/jeanibarz/agent-notebook/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/jeanibarz/agent-notebook/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/jeanibarz/agent-notebook/releases/tag/v0.1.3
