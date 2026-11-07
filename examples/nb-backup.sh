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
#                            `timeout` (GNU/coreutils); default 300.
# LOGS
#   $NB_DIR/.nb-backup.log  (rotated at ~1 MB)
# LOCK
#   ${XDG_RUNTIME_DIR:-$NB_DIR}/.nb-backup.lock  (prevents overlapping runs where
#   flock exists). User-scoped on purpose: a fixed world-writable /tmp path lets
#   any other user on a shared host squat or symlink-attack it (CWE-377).

set -uo pipefail

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

# 1) Commit any straggler changes (per-change auto-commit may be off). First make
#    sure this script's own transient files are ignored, so `git add -A` can't
#    sweep the backup log it just wrote back into history and churn a commit every
#    run (issue #274).
ensure_gitignore
git add -A 2>>"$LOG_FILE"
if ! git diff --cached --quiet; then
    if git commit --quiet -m "nb-backup ${DATESTAMP}" 2>>"$LOG_FILE"; then
        log "committed straggler changes"
    else
        log "COMMIT FAILED — see log"
    fi
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
