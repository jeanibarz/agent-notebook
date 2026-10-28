#!/usr/bin/env bash
# nb-backup.sh — push your Agent Notebook history to a remote, on a schedule.
#
# WHAT IT DOES
#   If NB_DIR is a git repo (set up per docs/harness-setup.md#git-versioning),
#   this (1) commits any straggler changes that the per-change wrapper missed,
#   then (2) PUSHES to the configured remote. Designed for cron/Task Scheduler
#   (run it daily) and for manual invocation. Idempotent: a no-op when there is
#   nothing new to commit and nothing unpushed.
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
#   NB_DIR   notebook repo (default ~/.agent-notebook/notebooks)
# LOGS
#   $NB_DIR/.nb-backup.log  (rotated at ~1 MB)
# LOCK
#   /tmp/agent-notebook-backup.lock  (prevents overlapping runs where flock exists)

set -uo pipefail

NB_DIR="${NB_DIR:-${HOME}/.agent-notebook/notebooks}"
LOG_FILE="${NB_DIR}/.nb-backup.log"
LOCK_FILE="/tmp/agent-notebook-backup.lock"
TIMESTAMP="$(date -Iseconds 2>/dev/null || date)"
DATESTAMP="$(date -I 2>/dev/null || date +%Y-%m-%d)"

log() { printf "[%s] %s\n" "$TIMESTAMP" "$*" >> "$LOG_FILE" 2>/dev/null || true; }

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

# 1) Commit any straggler changes (per-change auto-commit may be off).
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

if git push --quiet origin "$BRANCH" 2>>"$LOG_FILE"; then
    log "pushed ${BRANCH} OK"
else
    log "PUSH FAILED — local commits retained, will retry next run"
    exit 1
fi
