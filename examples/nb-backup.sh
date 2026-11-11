#!/usr/bin/env bash
# nb-backup.sh — push your Agent Notebook history to a remote, on a schedule.
#
# WHAT IT DOES
#   If NB_DIR is a git repo (set up per docs/harness-setup.md#git-versioning),
#   this (1) commits any straggler changes that the per-change wrapper missed,
#   then (2) PUSHES to the configured remote. Designed for cron/Task Scheduler
#   (run it daily) and for manual invocation. Idempotent: a no-op when there is
#   nothing new to commit and nothing unpushed. Before committing it also ensures
#   NB_DIR/.gitignore covers this script's own logs/locks, so a store set up
#   without the git-versioning recipe doesn't commit its own churning log.
#
#   Why push even when nothing was committed this run? If you use the per-change
#   wrapper (nb-git-wrapper.mjs), commits accumulate locally between runs; this
#   job's real job is to get them off the machine.
#
# USAGE
#   NB_DIR=~/.agent-notebook/notebooks ./nb-backup.sh
#   # cron, daily at 03:10:
#   10 3 * * * NB_DIR=$HOME/.agent-notebook/notebooks /path/to/nb-backup.sh \
#                >> $HOME/.agent-notebook/notebooks/.nb-backup.cron.log 2>&1
#
# PORTABILITY
#   Bash + git only. Runs on Linux, macOS, WSL, and Git Bash on Windows. It
#   avoids GNU-only flags (uses `wc -c`, not stat's byte-size flag) and runs
#   WITHOUT the single-instance lock where `flock` is absent (macOS) rather than
#   wedging. On native Windows without Git Bash, schedule `git -C <dir> push`
#   directly — see docs/harness-setup.md#windows.
#
# ENV
#   NB_DIR                   notebook repo (default ~/.agent-notebook/notebooks)
#   NB_BACKUP_PUSH_TIMEOUT   seconds (or any `timeout` duration, e.g. 5m) to cap
#                            the push so a hung credential/askpass prompt can't
#                            hold the lock forever; "0" disables the cap. Needs
#                            `timeout` (GNU/coreutils); default 300. An
#                            unrecognised value (e.g. "5min") is rejected with a
#                            logged config error and falls back to the default,
#                            so a typo can't turn every run into a push failure.
# LOGS
#   $NB_DIR/.nb-backup.log  (rotated at ~1 MB)
# GIT LOCK
#   The straggler `git add`/`git commit` runs under $NB_DIR/.nb-git.lock — the
#   same mkdir-dir lock nb-git-wrapper.mjs (withGitLock) takes around its commit
#   — so a backup commit can't collide with a live wrapper commit on
#   .git/index.lock. Waits up to 12 s; reclaims a lock older than 30 s (crashed
#   holder), mirroring the wrapper. If the lock stays held, the commit is skipped
#   this run (stragglers are picked up next run); the push still happens.
# LOCK
#   ${XDG_RUNTIME_DIR:-$NB_DIR}/.nb-backup.lock  (prevents overlapping runs where
#   flock exists). User-scoped on purpose: a fixed world-writable /tmp path lets
#   any other user on a shared host squat or symlink-attack it (CWE-377).

set -uo pipefail

# A leading `~` / `~/` in NB_DIR is expanded here, exactly like the package does (issue #334):
# a value set where no shell expands it (settings.json env, systemd, cron) would otherwise
# create a literal `~` directory in the current project. `~user/...` is left alone.
case "${NB_DIR:-}" in
  "~") NB_DIR="$HOME" ;;
  "~/"*) NB_DIR="$HOME/${NB_DIR#\~/}" ;;
esac
NB_DIR="${NB_DIR:-${HOME}/.agent-notebook/notebooks}"
LOG_FILE="${NB_DIR}/.nb-backup.log"
# Keep the lock in a user-owned, non-shared location so it can't collide with or
# be squatted/symlink-attacked by another user on a multi-user host (CWE-377).
# Prefer the per-user runtime dir (0700, private); else the user-owned NB_DIR,
# where `.nb-backup.*` is already gitignored by the recipe so the lock never gets
# committed. Both avoid the old fixed world-writable /tmp path. Fall back to
# NB_DIR too when XDG_RUNTIME_DIR is set but not a writable directory — otherwise
# `exec 9>` below would fail and the run would silently skip itself.
LOCK_DIR="${XDG_RUNTIME_DIR:-${NB_DIR}}"
[ -d "$LOCK_DIR" ] && [ -w "$LOCK_DIR" ] || LOCK_DIR="${NB_DIR}"
LOCK_FILE="${LOCK_DIR}/.nb-backup.lock"
TIMESTAMP="$(date -Iseconds 2>/dev/null || date)"
DATESTAMP="$(date -I 2>/dev/null || date +%Y-%m-%d)"

log() { printf "[%s] %s\n" "$TIMESTAMP" "$*" >> "$LOG_FILE" 2>/dev/null || true; }

# Ignore patterns for this script's OWN transient files — kept in sync with the
# git-versioning recipe (docs/harness-setup.md#git-versioning). They cover the
# backup/cron log and NB_DIR-fallback lock (.nb-backup.*), the CLI usage log and
# lock, temp files, and retrospective dotfiles.
GITIGNORE_PATTERNS=('.nb-usage.log*' '.nb.lock' '*.tmp' '.retro-*' '.nb-backup.*')

# Seed (or top up) NB_DIR's .gitignore so the straggler `git add -A` below never
# sweeps this script's own LOG_FILE — which lives in NB_DIR — or the usage log,
# locks, temp, and retro dotfiles into history. Without it, a store set up
# WITHOUT the git-versioning recipe (hence no .gitignore) commits .nb-backup.log
# on every run: the log line the PREVIOUS run just wrote. The job would then
# never be the idempotent no-op its header promises and would endlessly churn
# "nb-backup <date>" commits carrying only its own log. We append only the
# patterns not already present, so a user's custom .gitignore is preserved, and
# the whole thing is best-effort — a write failure must never abort the backup.
ensure_gitignore() {
    local gi='.gitignore' pat
    local -a missing=()
    for pat in "${GITIGNORE_PATTERNS[@]}"; do
        if [ ! -f "$gi" ] || ! grep -qxF -- "$pat" "$gi" 2>/dev/null; then
            missing+=("$pat")
        fi
    done
    [ "${#missing[@]}" -eq 0 ] && return 0
    # If the file exists and its last line lacks a trailing newline, our first
    # appended pattern would glue onto it — add the separator first.
    if [ -s "$gi" ] && [ -n "$(tail -c1 "$gi" 2>/dev/null)" ]; then
        printf '\n' >> "$gi" 2>>"$LOG_FILE" || true
    fi
    if printf '%s\n' "${missing[@]}" >> "$gi" 2>>"$LOG_FILE"; then
        log "seeded .gitignore pattern(s): ${missing[*]}"
    fi
}

if [ ! -d "${NB_DIR}/.git" ]; then
    echo "nb-backup: ${NB_DIR} is not a git repo — nothing to back up." >&2
    echo "           Set it up once:  (cd \"${NB_DIR}\" && git init && git remote add origin <url>)" >&2
    exit 0
fi

mkdir -p "$NB_DIR" 2>/dev/null || true

# Rotate the log if >1 MB so it never grows unbounded. `wc -c` is portable.
if [ -f "$LOG_FILE" ] && [ "$(wc -c < "$LOG_FILE" 2>/dev/null || echo 0)" -gt 1048576 ]; then
    mv "$LOG_FILE" "${LOG_FILE}.1" 2>/dev/null || true
fi

# Single-instance lock (non-blocking). `flock` is util-linux-only; where it is
# absent, run WITHOUT the lock rather than treating a missing command as locked.
if command -v flock >/dev/null 2>&1; then
    exec 9>"$LOCK_FILE"
    if ! flock -n 9; then
        log "another nb-backup run is in progress; skipping"
        exit 0
    fi
fi

cd "$NB_DIR" || { log "cd failed: $NB_DIR"; exit 1; }

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"

# Take the git-wrapper's `.nb-git.lock` (an atomic mkdir-dir lock) so our
# add/commit never runs concurrently with a wrapper commit — the two otherwise
# share one repo but only each other's private locks, and could collide on
# .git/index.lock (issue #305). Constants and stale-reclaim mirror withGitLock in
# nb-git-wrapper.mjs: wait ~12 s; a lock older than 30 s is a crashed holder's.
GIT_LOCK="${NB_DIR}/.nb-git.lock"
GIT_LOCK_WAIT_S="${NB_BACKUP_GIT_LOCK_WAIT:-12}"
case "$GIT_LOCK_WAIT_S" in ''|*[!0-9]*) GIT_LOCK_WAIT_S=12 ;; esac
GIT_LOCK_STALE_S=30
GIT_LOCK_HELD=0
GIT_LOCK_FAIL=""       # why acquire_git_lock gave up: "busy" | "unwritable"
GIT_LOCK_ELAPSED=0     # seconds actually spent waiting, for the "busy" message

lock_mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }

release_git_lock() {
    if [ "$GIT_LOCK_HELD" -eq 1 ]; then
        rmdir "$GIT_LOCK" 2>/dev/null || true
        GIT_LOCK_HELD=0
    fi
}
trap release_git_lock EXIT

acquire_git_lock() {
    local waited=0 absent=0 mt now aside start
    start="$(date +%s)"
    while :; do
        if mkdir "$GIT_LOCK" 2>/dev/null; then
            GIT_LOCK_HELD=1
            return 0
        fi
        # mkdir failed but the lock directory is absent. Either the holder
        # released it between our mkdir and this check (a real race — just retry,
        # issue #371), or the store is unwritable and waiting won't help. Tell
        # them apart by retrying: a released lock is free on the next mkdir, an
        # unwritable store keeps failing, so give up only after 3 consecutive
        # absent-and-failed attempts (the wrapper's errno check has no such window).
        if [ ! -d "$GIT_LOCK" ]; then
            absent=$((absent + 1))
            if [ "$absent" -ge 3 ]; then
                GIT_LOCK_FAIL=unwritable
                return 1
            fi
            sleep 0.05 2>/dev/null || true
            continue
        fi
        absent=0
        mt="$(lock_mtime "$GIT_LOCK")"
        now="$(date +%s)"
        if [ -n "$mt" ] && [ $((now - mt)) -gt "$GIT_LOCK_STALE_S" ]; then
            # Claim the stale lock atomically by renaming it aside: only one
            # racer's mv wins, so two waiters can't both delete a fresh successor.
            aside="${GIT_LOCK}.stale.$$"
            if mv "$GIT_LOCK" "$aside" 2>/dev/null; then
                rm -rf "$aside"
            fi
            # Retry the mkdir, but still count this pass toward the wait budget
            # below, so an undeletable stale lock can't spin us forever.
        fi
        if [ "$waited" -ge $((GIT_LOCK_WAIT_S * 5)) ]; then
            GIT_LOCK_FAIL=busy
            GIT_LOCK_ELAPSED=$(( $(date +%s) - start ))
            return 1
        fi
        sleep 0.2 2>/dev/null || sleep 1
        waited=$((waited + 1))
    done
}

# 1) Commit any straggler changes (per-change auto-commit may be off). First make
#    sure this script's own transient files are ignored, so `git add -A` can't
#    sweep the backup log it just wrote back into history and churn a commit every
#    run (issue #274).
ensure_gitignore
if acquire_git_lock; then
    # Never stage, commit or push a store that is mid-merge/rebase or holds
    # unmerged paths: `git add -A` would mark conflicted files resolved, the
    # commit would conclude the merge, and the push would publish conflict
    # markers to every other clone (issue #399). Leave everything for a human.
    INPROGRESS=""
    if [ -n "$(git ls-files -u 2>/dev/null)" ]; then
        INPROGRESS="unmerged paths"
    else
        for gp in MERGE_HEAD rebase-merge rebase-apply; do
            gpath="$(git rev-parse --git-path "$gp" 2>/dev/null)" || continue
            if [ -n "$gpath" ] && [ -e "$gpath" ]; then
                INPROGRESS="$gp present"
                break
            fi
        done
    fi
    if [ -n "$INPROGRESS" ]; then
        log "MERGE IN PROGRESS (${INPROGRESS}) — resolve it, then rerun; commit and push skipped"
        release_git_lock
        exit 1
    fi
    git add -A 2>>"$LOG_FILE"
    if ! git diff --cached --quiet; then
        if git commit --quiet -m "nb-backup ${DATESTAMP}" 2>>"$LOG_FILE"; then
            log "committed straggler changes"
        elif [ -z "$(git config user.email 2>/dev/null)" ] || [ -z "$(git config user.name 2>/dev/null)" ]; then
            # The quick-start versioning setup is `git init` only
            # (docs/harness-setup.md#git-versioning) and never sets a commit
            # identity. On a host with no global user.email/user.name — common in
            # CI images and containers — every commit fails with git's "Please
            # tell me who you are", which swallowed into a bare COMMIT FAILED makes
            # versioning look configured while it silently records nothing (issue
            # #308). Map that specific cause to one actionable line so the operator
            # knows the fix, instead of a cause-less failure.
            log "COMMIT FAILED: no git identity — set user.email and user.name to enable versioning, e.g. git -C \"${NB_DIR}\" config user.email you@example.com && git -C \"${NB_DIR}\" config user.name \"Your Name\""
        else
            log "COMMIT FAILED — see log"
        fi
    fi
    release_git_lock
elif [ "$GIT_LOCK_FAIL" = unwritable ]; then
    log "cannot create git lock ${GIT_LOCK} (notebooks directory not writable?); skipping straggler commit"
else
    log "git lock ${GIT_LOCK} busy after ${GIT_LOCK_ELAPSED}s; skipping straggler commit (will retry next run)"
fi

# 2) Push. No --force; a rejected push means someone pushed out of band — log
#    and bail so a human resolves it, rather than clobbering remote history.
if [ -z "$(git remote 2>/dev/null)" ]; then
    log "no git remote configured — commits retained locally, nothing pushed"
    exit 0
fi

# Fail fast instead of hanging forever on a credential/askpass prompt. This job
# runs unattended (cron) while holding the single-instance lock (fd 9) for its
# whole life, so a push that blocks waiting for an expired credential, an SSH
# passphrase, or an unknown-host confirmation would never release the lock —
# wedging EVERY later run with "another nb-backup run is in progress; skipping"
# and silently disabling the off-the-machine backup this script exists to give.
# Make git/ssh error out (so the run logs, releases the lock, and retries next
# time) rather than wait for input that never comes in a non-interactive job:
#   - GIT_TERMINAL_PROMPT=0 stops git prompting on the terminal for HTTPS creds.
#   - For SSH remotes, BatchMode=yes turns passphrase/password/host-key prompts
#     into an immediate error and ConnectTimeout bounds a stalled TCP connect.
#     Only set GIT_SSH_COMMAND when the user has not, so a custom ssh wrapper wins.
export GIT_TERMINAL_PROMPT=0
if [ -z "${GIT_SSH_COMMAND:-}" ]; then
    export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=30"
fi

# Backstop ceiling on the push for any other way it could stall (a half-open
# connection, a hung credential helper). GNU `timeout` runs the push in its own
# process group and kills the whole group on expiry, so even a lingering
# transport child can't keep holding the lock. `timeout` is GNU/coreutils —
# absent on stock macOS, and on some Git Bash PATHs shadowed by Windows'
# System32 `timeout.exe`, which can't wrap a command — so use it only when it both
# exists AND actually runs a command (`timeout 1 true`); otherwise push unwrapped
# rather than wedge where it is missing. NB_BACKUP_PUSH_TIMEOUT overrides the
# default ("0" disables the wrapper, "5m" for a long haul).
PUSH_TIMEOUT="${NB_BACKUP_PUSH_TIMEOUT:-300}"
# Validate the duration BEFORE handing it to `timeout`. A malformed interval
# (e.g. "5min", "abc") makes `timeout "$PUSH_TIMEOUT" git push` exit 125
# ("invalid time interval") — a failure the push step below logs as the generic
# "PUSH FAILED — will retry next run" on EVERY run, indistinguishable from a real
# transient push error, so one typo silently disables the off-machine backup
# forever (issue #311). Accept the `timeout` DURATION grammar the header
# documents: a number (integer or decimal) with an optional s/m/h/d unit — e.g.
# 300, 5m, 1.5, 0.5s ("0" is valid and disables the wrapper via the guard below).
# On anything else, log a DISTINCT config error — so the operator can tell a typo
# from a genuine push failure — and fall back to the 300 s default so the backup
# keeps running instead of wedging. The pattern lives in a variable because an
# unquoted `[[ =~ ]]` regex with `(...)` is the portable form across bash 3.2+.
PUSH_TIMEOUT_RE='^[0-9]+(\.[0-9]+)?[smhd]?$'
if [[ ! "$PUSH_TIMEOUT" =~ $PUSH_TIMEOUT_RE ]]; then
    log "CONFIG ERROR: NB_BACKUP_PUSH_TIMEOUT='${PUSH_TIMEOUT}' is not a valid timeout duration (expected e.g. 300 or 5m); falling back to 300"
    PUSH_TIMEOUT=300
fi
if [ "$PUSH_TIMEOUT" != "0" ] && command -v timeout >/dev/null 2>&1 && timeout 1 true >/dev/null 2>&1; then
    push() { timeout "$PUSH_TIMEOUT" git push --quiet origin "$BRANCH"; }
else
    push() { git push --quiet origin "$BRANCH"; }
fi

if push 2>>"$LOG_FILE"; then
    log "pushed ${BRANCH} OK"
else
    log "PUSH FAILED — local commits retained, will retry next run"
    exit 1
fi
