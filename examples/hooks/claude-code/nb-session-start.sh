#!/usr/bin/env bash
# Claude Code SessionStart hook — inject the NOTEBOOK INDEX so the agent sees it
# without spending a call. Optional convenience: the AGENTS.md/CLAUDE.md contract
# already tells the agent to run `nb list` itself; this just front-loads the
# result. Its stdout is added to the session context.
#
# Deliberately generic: it injects the INDEX of every notebook (each with its
# "open me when…" description), NOT a guessed per-project notebook name — so it
# works the same in every repo, and the hook never chooses a notebook for the agent. The agent reads the
# descriptions and opens whatever fits its task (that's moment ① → ②).
#
# OPTIONAL, OFF BY DEFAULT — layered variant (a CONVENTION, not an `nb` feature):
# set NB_PROJECT_SLUG (e.g. `acme-app`) in the environment that launches Claude
# Code and the index is grouped into project / domain / global shelves instead
# of one flat list. See docs/memory-layers.md. With NB_PROJECT_SLUG unset (the
# default) this script behaves exactly as described above. Even in the layered
# variant the hook only sorts and hides rows of the INDEX; it never opens a shelf
# for the agent, and `nb list` still shows everything.
set -uo pipefail

NB="${NB_BIN:-nb}"   # point NB_BIN at the git-versioning wrapper if you use one

# Fail-open: if `nb` is missing, inject nothing rather than erroring the session.
command -v "$NB" >/dev/null 2>&1 || exit 0

echo "## Your agent-notebook index"
echo "These are the available notebooks (bounded, voted, one-line lessons; each name is a shelf),"
echo "written by you and by other agents. Open the one(s) whose description fits this"
echo "task with \`nb show <shelf>\` (the name shown below) — and open more the moment the task reveals a need"
echo "you didn't see coming (a snag recorded in another notebook). Use their"
echo "lessons. At the end, run the retrospective: vote +1 on what helped and -1 on"
echo "what misled, prune / merge / split to keep each notebook sharp (as many as"
echo "apply), and add at most one new durable lesson."
echo
# ── Layered variant (convention example; skipped unless NB_PROJECT_SLUG is set) ──
# Layers are read off the shelf NAME, nothing is stored in a shelf file:
#   project  <situation>@<slug>   the text after the LAST "@" equals the slug
#                                  (compared ignoring case)
#   other    <situation>@<other>  another project's shelf: hidden from this
#                                  index, with a count so it never looks absent
#   global   one bare shelf named by NB_GLOBAL_SHELF (default `global`)
#   domain   every other bare shelf (no "@")
# Prints the grouped index and returns 0. Returns non-zero without printing
# anything when `nb list --json` fails or is not JSON, so the caller falls back
# to the flat index below (fail open: a session start never errors).
# `--limit 1000` lifts the default 50-row cap so the hidden count is exact for any
# store under 1000 shelves; beyond that, a line says how many shelves were not read.
# Only POSIX shell plus `node` (which `nb` already needs): no bash-4 syntax, so
# it also runs under macOS's bash 3.2.
layered_index() {
  local json
  json="$("$NB" list --json --limit 1000 2>/dev/null)" || return 1
  printf '%s' "$json" | LAYER_SLUG="$1" LAYER_GLOBAL="${NB_GLOBAL_SHELF:-global}" node -e '
    const fs = require("fs");
    let data;
    try { data = JSON.parse(fs.readFileSync(0, "utf8")); } catch (e) { process.exit(1); }
    if (!data || !Array.isArray(data.rows)) process.exit(1);
    const slug = process.env.LAYER_SLUG.trim();
    const slugKey = slug.toLowerCase();
    const globalName = process.env.LAYER_GLOBAL;
    const layers = { project: [], domain: [], global: [] };
    let hidden = 0;
    for (const r of data.rows) {
      const at = r.shelf.lastIndexOf("@");
      if (at >= 0) {
        if (r.shelf.slice(at + 1).toLowerCase() === slugKey) layers.project.push(r);
        else hidden++;
      } else if (r.shelf === globalName) layers.global.push(r);
      else layers.domain.push(r);
    }
    const row = (r) => "  " + r.shelf + "  " + r.lessons + "  " + String(r.desc || r.auto || "").slice(0, 100);
    const section = (title, rows, ifEmpty) => {
      if (!rows.length && ifEmpty === undefined) return;
      console.log("### " + title);
      console.log(rows.length ? rows.map(row).join("\n") : "  " + ifEmpty);
    };
    console.log("Precedence if lessons conflict: project > domain > global.");
    console.log("Write a new lesson to the narrowest shelf it is true for: " + "<situation>@" + slug + " by default; a bare domain shelf only if it holds in any repo.");
    console.log("");
    section("Project layer (shelves ending in @" + slug + ")", layers.project, "(none yet — a new project shelf is created by your first `nb add <situation>@" + slug + " …`)");
    section("Domain layer (bare shelves)", layers.domain);
    section("Global layer", layers.global);
    console.log("");
    const unread = (data.total || 0) - data.rows.length;
    if (unread > 0)
      console.log("  (" + unread + " more shelf(s) were not classified; `nb list` shows all)");
    if (hidden > 0 && layers.project.length === 0)
      console.log("  (NOTE: " + hidden + " shelf(s) for other projects hidden and NONE end in @" + slug + " — if that slug is wrong, run `nb list` to see them all)");
    else
      console.log("  (" + hidden + " shelf(s) for other projects hidden (slug: " + slug + "); `nb list` shows all)");
  ' || return 1
}

# A blank or whitespace-only slug counts as unset (the layered index needs a slug).
slug="${NB_PROJECT_SLUG:-}"
slug="${slug#"${slug%%[![:space:]]*}"}"   # trim leading whitespace (POSIX, bash 3.2-safe)
if [ -n "$slug" ]; then
  layered="$(layered_index "$slug")" && { printf '%s\n' "$layered"; exit 0; }
  echo "  (WARNING: layered index unavailable — showing the flat index instead)"
fi

# Capture first so a FAILING `nb list` (corrupt store, EACCES, …) is told apart
# from a genuinely EMPTY one — a pipeline `|| echo` would conflate them.
out="$("$NB" list 2>/dev/null)"
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "  (WARNING: \`nb list\` failed with exit $rc — the notebook store may be broken; run \`nb list\` yourself to investigate)"
elif [ -z "$out" ]; then
  echo "  (no notebooks yet — you'll start one at task end)"
else
  printf '%s\n' "$out" | sed 's/^/  /'
fi
exit 0
