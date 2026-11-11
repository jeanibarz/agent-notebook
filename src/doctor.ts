/**
 * `nb doctor` (issue #338): a strictly read-only structural check of a notebooks
 * directory. The tolerant parser, case-sensitive shelf names and best-effort
 * recovery paths let a directory hold conflict markers, malformed lines, control
 * characters, case-colliding shelves, over-cap shelves, 0-byte files and crash
 * debris without any command saying so; this reports all of it in one pass.
 *
 * It never takes the mutation lock and never writes: every check reads the
 * directory listing, `stat`, or a shelf file. Detectors are the ones the rest of
 * the tool already uses (`isConflictMarker`, `stripControlChars`, `isMetaLine`,
 * `isLeftoverTemp`, `maxChars`/`maxLines`, `staleLockMs`) so a definition of
 * "broken" cannot drift between a command's guard and this report.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  isConflictMarker,
  isLeftoverTemp,
  isMetaLine,
  listShelves,
  maxChars,
  maxLines,
  sanitizeLesson,
  staleLockMs,
  stripControlChars,
} from './notebook.js';

export const DOCTOR_SCHEMA_VERSION = 1;

export type DoctorCode =
  | 'conflict-marker'
  | 'bad-score'
  | 'control-char'
  | 'case-collision'
  | 'lesson-too-long'
  | 'shelf-over-cap'
  | 'empty-file'
  | 'leftover-temp'
  | 'stale-lock'
  | 'unreadable';

export interface DoctorFinding {
  code: DoctorCode;
  /** The shelf the finding is about; for `leftover-temp` the temp file name, for `stale-lock` `.nb.lock`. */
  shelf: string;
  /** 1-based line in the shelf file, when the finding is about one line. */
  line?: number;
  message: string;
}

export interface DoctorReport {
  schemaVersion: number;
  /** Number of shelf files examined. */
  shelves: number;
  findings: DoctorFinding[];
}

/** A well-formed entry line: `+3\t…`, `-1\t…` or `0\t…` (what `formatLine` writes, sign optional). */
const SCORED_LINE_RE = /^[+-]?\d+\t/;

export function doctor(dir: string): DoctorReport {
  const findings: DoctorFinding[] = [];
  const shelves = listShelves(dir);
  const cap = maxLines();
  const maxLen = maxChars();

  for (const shelf of shelves) {
    let raw: string;
    try {
      raw = readFileSync(join(dir, `${shelf}.md`), 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code ?? 'EIO';
      if (code === 'ENOENT') continue; // unlinked after the listing (a racing `nb rm`), as readShelf (#300)
      findings.push({ code: 'unreadable', shelf, message: `cannot read ${shelf}.md (${code})` });
      continue;
    }
    if (raw === '') {
      findings.push({ code: 'empty-file', shelf, message: `${shelf}.md is a 0-byte file` });
      continue;
    }
    let inMeta = true;
    let lessons = 0;
    let conflictSeen = false;
    const lines = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).split(/\r?\n/);
    lines.forEach((line, i) => {
      const n = i + 1;
      if (stripControlChars(line) !== line) {
        findings.push({ code: 'control-char', shelf, line: n, message: 'line holds a control or bidi character' });
      }
      if (isConflictMarker(line)) {
        if (!conflictSeen) {
          conflictSeen = true;
          findings.push({ code: 'conflict-marker', shelf, line: n, message: `git merge-conflict marker ${JSON.stringify(line)}` });
        }
        inMeta = false;
        return;
      }
      if (inMeta && isMetaLine(line)) return;
      inMeta = false;
      if (line.trim() === '') return;
      const tab = line.indexOf('\t');
      const text = sanitizeLesson(tab === -1 ? line : line.slice(tab + 1));
      if (text === '') return; // readShelf drops an empty-text entry, so it is not a lesson
      lessons++;
      if (!SCORED_LINE_RE.test(line)) {
        findings.push({ code: 'bad-score', shelf, line: n, message: 'line has no valid `<score>\\t` prefix (the score is read leniently or as 0)' });
      }
      if (text.length > maxLen) {
        findings.push({ code: 'lesson-too-long', shelf, line: n, message: `lesson is ${text.length} chars; cap is ${maxLen}` });
      }
    });
    if (lessons > cap) {
      findings.push({ code: 'shelf-over-cap', shelf, message: `${lessons} lessons; cap is ${cap}` });
    }
  }

  // Shelf names that differ only by case collide on case-insensitive filesystems.
  const byLower = new Map<string, string[]>();
  for (const s of shelves) {
    const k = s.toLowerCase();
    byLower.set(k, [...(byLower.get(k) ?? []), s]);
  }
  for (const group of byLower.values()) {
    if (group.length < 2) continue;
    for (const s of group) {
      const others = group.filter((o) => o !== s).map((o) => JSON.stringify(o)).join(', ');
      findings.push({ code: 'case-collision', shelf: s, message: `differs only by case from ${others}` });
    }
  }

  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    /* no directory yet: nothing else to check */
  }
  // doctor holds no lock, so a temp may belong to a live writer mid atomic-write;
  // only one older than the stale-lock threshold is crash debris (same bound as the lock).
  const isStale = (name: string): boolean => {
    try {
      return Date.now() - statSync(join(dir, name)).mtimeMs > staleLockMs();
    } catch {
      return false; // renamed or removed by its writer meanwhile
    }
  };
  for (const name of names.filter((n) => isLeftoverTemp(dir, n) && isStale(n)).sort()) {
    findings.push({ code: 'leftover-temp', shelf: name, message: `${name} is a temp file left by a crashed write` });
  }
  try {
    const age = Date.now() - statSync(join(dir, '.nb.lock')).mtimeMs;
    if (age > staleLockMs()) {
      findings.push({ code: 'stale-lock', shelf: '.nb.lock', message: `.nb.lock untouched for ${Math.round(age / 1000)}s; its holder likely crashed` });
    }
  } catch {
    /* no lock: healthy */
  }

  return { schemaVersion: DOCTOR_SCHEMA_VERSION, shelves: shelves.length, findings };
}

/** Human render: one OK line, or one line per finding plus a total. */
export function renderDoctor(rep: DoctorReport, dir?: string): string {
  const count = `${rep.shelves} ${rep.shelves === 1 ? 'shelf' : 'shelves'}`;
  if (rep.findings.length === 0) {
    // Zero shelves means nothing was checked (issue #381): say so, and whether the
    // directory is missing (a likely mistyped NB_DIR) or merely holds no shelf.
    if (rep.shelves === 0) {
      const why = dir !== undefined && !existsSync(dir) ? 'the notebooks directory does not exist' : 'the notebooks directory holds no shelf';
      return `nb doctor: OK — 0 shelves checked (${why}), no problems found`;
    }
    return `nb doctor: OK — ${count} checked, no problems found`;
  }
  const rows = rep.findings.map((f) => `  ${f.code}  ${f.shelf}${f.line ? `:${f.line}` : ''}  ${f.message}`);
  return [`nb doctor: ${rep.findings.length} problem(s) in ${count}`, ...rows].join('\n');
}
