/**
 * The `nb config` report (issue #188; status-aware since issue #336; issue #493
 * moved it here from `cli.ts`). It lists every numeric `NB_*` tunable at the
 * value its live getter resolves to right now, says whether a set value was
 * honored, clamped or ignored, shows the string variables (`NB_DIR`,
 * `NB_SESSION`, `NB_ASCII`), the per-repository on/off state (issue #514), and
 * names any `NB_*` variable `nb` does not read.
 *
 * The tunable registry here is the single list of variables `nb` recognises;
 * each resolver reproduces its `notebook.ts` getter, and `cli.test.ts` checks
 * the two agree. `cli.ts` keeps the dispatch and the `--json` object; this
 * module builds the rows and the human text. It reads `process.env` and never
 * writes.
 */
import {
  COVERAGE_HI,
  ERR_MIN,
  ADD_BURST_N,
  ERR_RATE,
  LOCK_GRACE_MS,
  LOOP_N,
  LOOP_WINDOW_S,
  MAX_CHARS,
  MAX_LINES,
  NEAR_DUP,
  notebooksDir,
  RECALL_MISS_HI,
  resolveIntTunableStatus,
  escapeDiskName,
  resolveRateEnv,
  SILENT_H,
  STALE_LOCK_MS,
  USAGE_RING,
  usageRingSlack,
  type IntTunable,
  type RateTunable,
} from './notebook.js';
import { asciiMode } from './stats.js';
import {
  MESSAGES_DIR_DISPLAY,
  MESSAGE_NAMES_SHOWN,
  listMessages,
  otherProjectFiles,
  readMessages,
  type MessageFile,
} from './messages.js';
import { closestMatch } from './suggest.js';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describeSource, stateWord, type EnabledState } from './enabled.js';

/** Where a tunable's effective value came from: a set env var, the built-in default, or a derived value with no own env var. */
export type ConfigSource = 'env' | 'default' | 'derived' | '.nb.json';

/**
 * How a set numeric env var was resolved (issue #336): used as given, silently
 * clamped to a bound, or silently ignored (unparseable, default used). Absent
 * for the derived row and for a default (the var is unset). This is the
 * information `source` alone cannot carry — `source: 'env'` says "you set it",
 * while `status: 'ignored'` says "and `nb` threw it away".
 */
export type ConfigStatus = 'honored' | 'clamped' | 'ignored';

/** One `nb config` row: the tunable's config name, the value its live getter resolves to RIGHT NOW, and the env var that overrides it (null for a derived value). */
interface ConfigRow {
  name: string;
  value: number;
  env: string | null;
  /** How the env value was resolved; `null` for the derived row or when the var is unset. */
  status: ConfigStatus | null;
  /** Set only when the folder's `.nb.json` decided the value (RFC 0530); otherwise the source is derived from the env var. */
  source?: '.nb.json';
  /** The raw env string when the var is set (so the human line can quote it), else `null`. */
  rawValue: string | null;
  /** The parse family, for the `ignored` wording ("not an integer" vs "not a number"). */
  kind: 'int' | 'rate';
}

/**
 * One numeric tunable in the shared registry: its config name, the `NB_*` var
 * that overrides it, its built-in default, and a resolver that reproduces its
 * getter's clamp exactly. Each resolver returns the SAME number the exported
 * getter returns — and ALSO reports whether that number came from an honored,
 * clamped or ignored raw value ([issue #336]). The `cli.test.ts` config test
 * cross-checks every resolver's value against the exported getter, so a drift in
 * either direction (a changed default, a changed clamp) fails loudly.
 *
 * The registry is the single source of the recognised-variable set: both
 * `effectiveConfig` and the unknown-`NB_*` scan derive from it, so a variable
 * cannot be reported but unknown, or read but unreported.
 */
interface TunableSpec {
  name: string;
  env: string;
  kind: 'int' | 'rate';
  resolve: () => { value: number; status: 'default' | ConfigStatus; fromFile?: boolean; fileRaw?: string };
}

/**
 * Resolve an int tunable from `NB_<env>` read live. A thin wrapper over
 * `resolveIntTunableStatus` so the registry stays declarative while still reading
 * `process.env` at call time, exactly like the hot-path getters.
 */
function intTunable(name: string, t: IntTunable): TunableSpec {
  return { name, env: t.env, kind: 'int', resolve: () => resolveIntTunableStatus(t) };
}

/** Resolve a rate tunable (bounds [0, 1]) from its `NB_*` var read live. */
function rateTunable(name: string, t: RateTunable): TunableSpec {
  return { name, env: t.env, kind: 'rate', resolve: () => resolveRateEnv(process.env[t.env], t.dflt) };
}

/**
 * The source of truth for the numeric tunables `nb config` reports (issue #188),
 * made status-aware in issue #336. Each default and bound mirrors its hot-path
 * getter in `notebook.ts`; the config test asserts the resolved value equals the
 * exported getter for a matrix of raw values, so the two can never drift.
 * `usageRingSlack` is DERIVED from `usageRing` and has no env var of its own, so
 * it is not a registry entry — it is rendered separately.
 */
const TUNABLE_REGISTRY: readonly TunableSpec[] = [
  intTunable('maxLines', MAX_LINES),
  intTunable('maxChars', MAX_CHARS),
  rateTunable('nearThreshold', NEAR_DUP),
  intTunable('usageRing', USAGE_RING),
  intTunable('staleLockMs', STALE_LOCK_MS),
  intTunable('lockGraceMs', LOCK_GRACE_MS),
  intTunable('loopN', LOOP_N),
  intTunable('loopWindowSec', LOOP_WINDOW_S),
  intTunable('silentHours', SILENT_H),
  intTunable('errMin', ERR_MIN),
  intTunable('addBurstN', ADD_BURST_N),
  rateTunable('errRate', ERR_RATE),
  rateTunable('coverageHi', COVERAGE_HI),
  rateTunable('recallMissHi', RECALL_MISS_HI),
];

/**
 * The effective, post-clamp tunables `nb config` reports (issue #188): the
 * registry rows, each resolved live and annotated with its `status`/`rawValue`
 * (issue #336), plus the DERIVED `usageRingSlack` row (no env var of its own),
 * spliced into its historical position so a clean render stays byte-identical.
 * Every value is the number the hot-path getter returns, so a printed value can
 * never drift from the value `nb` actually runs under — the #116-class drift the
 * #131 guard exists to prevent.
 */
export function effectiveConfig(): ConfigRow[] {
  const rows: ConfigRow[] = TUNABLE_REGISTRY.map((t) => {
    const { value, status, fromFile, fileRaw } = t.resolve();
    const raw = process.env[t.env];
    return {
      name: t.name,
      value,
      env: t.env,
      status: status === 'default' ? null : status,
      ...(fromFile ? { source: '.nb.json' as const } : {}),
      // For a `.nb.json` value the raw text is the number the file held, which the clamp note quotes.
      rawValue: fromFile ? (fileRaw ?? null) : (raw ?? null),
      kind: t.kind,
    };
  });
  // Keep the DERIVED row in its historical position (after `usageRing`, before
  // `staleLockMs`) so a clean render stays byte-identical to the pre-#336 output.
  rows.splice(4, 0, { name: 'usageRingSlack', value: usageRingSlack(), env: null, status: null, rawValue: null, kind: 'int' });
  return rows;
}

/**
 * One behavior-critical STRING env var `nb config` surfaces alongside the
 * numeric clamps (issue #312). `name` is the env var itself — it doubles as the
 * display label and the `--json` key, so there is no separate `env` field to
 * drift from it.
 */
interface EnvRow {
  name: string;
  value: string;
}

/**
 * The three string env vars that most often explain a misbehaving deployment
 * (issue #312): `NB_DIR` (where notebooks live), `NB_SESSION` (the id the
 * usage/engagement diagnostics group by — its unset state is the usual cause of
 * `nb stats` reporting "no engaged sessions"), and `NB_ASCII` (the rendering
 * mode). `effectiveConfig` reports only the numeric clamps, so these were
 * structurally invisible to the very command `nb`'s own help points an operator
 * at. Each value is read from the SAME resolver the hot path uses — `notebooksDir`
 * for storage, the effective `NB_SESSION` for the session id, `asciiMode` for the
 * post-locale rendering mode — so a printed value can never drift from what `nb`
 * actually runs under, exactly as the numeric rows don't. Source is classified by
 * `configSource`'s `!== undefined` rule: a var set to blank still reads `(env)`
 * (e.g. `NB_DIR=` reads `(env)` while its value falls back to the default dir),
 * mirroring the numeric DP-5 contract.
 */
export function environmentRows(): EnvRow[] {
  return [
    { name: 'NB_DIR', value: notebooksDir() },
    { name: 'NB_SESSION', value: process.env.NB_SESSION ?? '' },
    { name: 'NB_ASCII', value: asciiMode() ? 'on' : 'off' },
  ];
}

/**
 * Every `NB_*` variable name `nb` actually reads — the registry's numeric vars
 * plus the three string vars — as a set. This is the reference list the unknown
 * scan checks against, derived from the SAME registry `effectiveConfig` uses so
 * the two cannot drift (a var that is read can never be reported "unrecognized",
 * and a new tunable is automatically recognised; issue #336).
 */
function recognizedEnvVars(): string[] {
  // NB_ENABLED (issue #514) is read by `nb enabled` and reported on the `enabled=` line.
  // The `nb brief` and `nb retro` reads (issue #538) are listed here, so they are no longer
  // reported as "not read by nb"; they get no row of their own.
  return [...TUNABLE_REGISTRY.map((t) => t.env), ...environmentRows().map((r) => r.name), 'NB_ENABLED', ...RETRO_ENV_VARS];
}

/** The variables `nb brief` and `nb retro` read (issue #538, FR-BRIEF-003, FR-RETRO-002/003). */
const RETRO_ENV_VARS: readonly string[] = ['NB_RETRO_EXTRA_PROMPT', 'NB_RETRO_TTL_DAYS', 'NB_PROJECT_SLUG', 'NB_GLOBAL_SHELF'];

/**
 * `NB_*` variables read by the tooling this repo SHIPS (the harness hooks, the
 * git-wrapper, the backup/janitor scripts under `examples/`) rather than by
 * `nb` itself (issue #336). A user who follows `examples/README.md` and exports
 * these would otherwise have them listed "unrecognized by nb" with a misleading
 * `did you mean NB_DIR?` — flagging a variable another tool legitimately set is
 * exactly what the issue's Risk section forbids. Reported as "not read by
 * `nb`" (not "unrecognized"), and never used as a suggestion candidate.
 */
const SHIPPED_TOOL_ENV_VARS: readonly string[] = [
  'NB_BIN',
  'NB_GIT_AUTOCOMMIT',
  'NB_GIT_SESSION_TRAILER',
  'NB_BACKUP_PUSH_TIMEOUT',
  'NB_BACKUP_GIT_LOCK_WAIT',
];

/** Width of the pre-round-2 `(unrecognized by nb)` tag a hinted one is padded to, so the block keeps its shape. */
const UNKNOWN_TAG_HISTORY_WIDTH = '(unrecognized by nb)'.length;

/** One unrecognized `NB_*` variable found in the environment, with a nearest-name hint when one is close. */
interface UnknownEnv {
  name: string;
  suggestion: string | undefined;
}

/**
 * Find every `NB_*`-prefixed variable in the environment that `nb` does not read
 * (issue #336) — a typo like `NB_MAX_LINE` (missing the `S`) that otherwise stays
 * silently set while every `nb` call ignores it. Purely informational: other
 * tools may legitimately set `NB_*` vars (including this repo's own shipped
 * examples, see {@link SHIPPED_TOOL_ENV_VARS}), so these are reported as "not
 * read by nb", never as an error, and the exit code is untouched. A close-enough
 * name gets a `did you mean` hint via the same Levenshtein/prefix matcher the
 * command and shelf typo paths use (`closestMatch`), sorted for deterministic
 * output, the hint sized to the historical `unrecognized by nb` tag so the
 * block stays byte-identical to the pre-round-2 output for a pure typo. A name
 * with NO close match is still listed — the promise is to surface every `NB_*`
 * var nb does not read, and a far-off typo (or a var some other tool owns) is
 * exactly the case the operator cannot discover otherwise; it just carries no
 * hint.
 */
export function unknownEnvVars(): UnknownEnv[] {
  const known = recognizedEnvVars();
  // Suggestions come only from nb's OWN vars: a near-miss of an example-tool
  // knob is not a typo of a tunable, and suggesting one would be wrong.
  //
  // `closestMatch` lowercases its needle, so compare against lowercased
  // candidates and map a hit back to the canonical (uppercase) var name.
  const byLower = new Map(known.map((k) => [k.toLowerCase(), k]));
  return Object.keys(process.env)
    .filter((k) => k.startsWith('NB_') && !known.includes(k) && !SHIPPED_TOOL_ENV_VARS.includes(k))
    .sort()
    .map((name) => {
      const hit = closestMatch(name, [...byLower.keys()]);
      return { name, suggestion: hit === undefined ? undefined : byLower.get(hit) };
    });
}

/**
 * Classify where a tunable's effective value comes from. A tunable with no env
 * var of its own (`env === null`) is `derived`; otherwise it is `env` when the
 * variable is DEFINED and `default` when it is unset (absent from the
 * environment). This is a statement about the ENVIRONMENT, not the value: a
 * set-but-out-of-range, non-numeric, or even blank var still reads `env`, while
 * the value `nb config` prints is always the post-clamp effective one.
 *
 * The test is `!== undefined`, NOT "non-blank": a var set to the empty string IS
 * set, and for a rate getter `clampRate` resolves `''` to `0` (via `Number('')`),
 * which is the value the hot path actually uses — so it must read `(env …)`, not
 * `(default)`. Tagging that `default` would print `errRate=0 (default)` while the
 * real default is `0.3`: a value/tag pair that silently misleads, the exact thing
 * FR-CONFIG-001 and DP-5 forbid.
 */
export function configSource(env: string | null): ConfigSource {
  if (env === null) return 'derived';
  return process.env[env] !== undefined ? 'env' : 'default';
}

/**
 * The parenthetical a human `nb config` numeric line carries after its source
 * tag, explaining a non-honored env value (issue #336):
 *   - `honored` → nothing (the value you set is in force; byte-identical to the
 *     pre-#336 output);
 *   - `clamped` → `: clamped to <value> from <raw>` (you asked for something out
 *     of range and got the bound instead);
 *   - `ignored` → `: ignored "<raw>", not an integer; using default` (unparseable,
 *     so `nb` quietly used the default — the misleading case this fixes).
 * Rates vs ints only differ in the wording ("not a number" vs "not an integer").
 */
function statusNote(row: ConfigRow, kind: 'int' | 'rate'): string {
  if (row.status === 'clamped') return `: clamped to ${row.value} from ${row.rawValue}`;
  if (row.status === 'ignored') {
    return `: ignored "${row.rawValue}", not ${kind === 'rate' ? 'a number' : 'an integer'}; using default`;
  }
  return '';
}

/**
 * Render `nb config` for the human path. One `name=value` line per numeric
 * tunable, the `name=value` column left-padded so the source tags line up. The
 * tag names the source: `(default)`, `(env NB_*)`, or `(derived from usageRing)`.
 * A clamped or ignored env value appends a status note inside the tag (issue
 * #336) so a value that was rewritten or thrown away can never read as honored.
 * A blank line then separates a `NB_*=value` block for the string env vars
 * (issue #312), tagged `(env)`/`(default)` — the var name is already the row
 * label, so the tag need not repeat it. When `enabled` is given, a one-line
 * block follows with the per-repository on/off state and the input that decided
 * it (issue #514). A final block lists unrecognized `NB_*`
 * vars (issue #336) when any exist. With no problems the output is byte-identical
 * to the pre-#336 renderer, apart from the `enabled=` line. Returns `{ out }` (stdout only) — there is no
 * error/empty state, the table is fixed.
 */
export function renderConfig(
  rows: ConfigRow[],
  envRows: EnvRow[],
  unknown: UnknownEnv[],
  enabled?: EnabledState,
  messages?: MessagesReport | null,
): { out: string } {
  const pairW = rows.reduce((w, r) => Math.max(w, `${r.name}=${r.value}`.length), 0);
  const lines = rows.map((r) => {
    if (r.source === '.nb.json') {
      // The folder's `.nb.json` set this value (RFC 0530); a clamp is noted like an env clamp.
      const note = r.status === 'clamped' ? `: clamped to ${r.value} from ${r.rawValue}` : '';
      return `${`${r.name}=${r.value}`.padEnd(pairW)}  (.nb.json${note})`;
    }
    const src = configSource(r.env);
    const base = src === 'env' ? `(env ${r.env})` : src === 'derived' ? '(derived from usageRing)' : '(default)';
    if (src !== 'env' || r.status === null) {
      return `${`${r.name}=${r.value}`.padEnd(pairW)}  ${base}`;
    }
    const note = statusNote(r, r.kind);
    const tag = note === '' ? base : `(env ${r.env}${note})`;
    return `${`${r.name}=${r.value}`.padEnd(pairW)}  ${tag}`;
  });
  const envPairW = envRows.reduce((w, r) => Math.max(w, `${r.name}=${r.value}`.length), 0);
  const envLines = envRows.map((r) => {
    const tag = configSource(r.name) === 'env' ? '(env)' : '(default)';
    return `${`${r.name}=${r.value}`.padEnd(envPairW)}  ${tag}`;
  });
  let out = lines.join('\n') + '\n\n' + envLines.join('\n') + '\n';
  if (enabled !== undefined) {
    // Issue #514: whether the agent-facing loop is on in this directory, and why.
    out += `\nenabled=${stateWord(enabled)}  (${describeSource(enabled)})\n`;
  }
  if (messages) out += '\n' + messages.lines.join('\n') + '\n';
  if (unknown.length > 0) {
    // Keep the tag the same width as the historical `(unrecognized by nb)` so a
    // pure typo re-renders identically. A var with NO close match is still shown
    // (just without a hint) — every `NB_*` nb does not read must surface.
    const unknownLines = unknown.map((u) => {
      const tag = u.suggestion === undefined
        ? '(not read by nb)'
        : `(not read by nb — did you mean ${u.suggestion}?)`;
      return `${u.name}  ${tag.padEnd(UNKNOWN_TAG_HISTORY_WIDTH)}`;
    });
    out += '\n' + unknownLines.join('\n') + '\n';
  }
  return { out };
}

/** The `messages` block of `nb config` (issue #539): its human lines and its `--json` value. */
export interface MessagesReport {
  lines: string[];
  json: Record<string, unknown>;
}

export interface MessagesReportInput {
  /** The home folder whose `.agent-notebook/messages/` is described. */
  home: string;
  /** The shared notebooks folder, for the containment check. */
  nbDir: string;
  /**
   * The project name that may select a message file and why (`messageProjectName` in
   * `loop.ts`). Called only when the block is shown, so a user without a `messages/`
   * folder starts no process for it.
   */
  project: () => { name: string | null; why: string; /** What `{project}` is filled with (the name `nb project` prints, the folder fallback included); `''` when none. */ fills: string };
  /** What `NB_RETRO_EXTRA_PROMPT` names (`extraPromptStatus` in `loop.ts`), and the real path of that file when it can be found. */
  extra: () => { set: boolean; path: string; text: string; why: string | null; real: string | null };
}

/** `2026-11-26 08:12`, in the local time zone, as `ls -l` shows a file's time. */
function changedAt(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fileTag(f: MessageFile, noteIfAbsent: string): string {
  if (f.status === 'used') return `in force, ${f.chars} character${f.chars === 1 ? '' : 's'}, changed ${changedAt(f.mtimeMs)}`;
  if (f.status === 'refused') return `not used: ${f.reason}`;
  return `none: no such file${noteIfAbsent}`;
}

function fileJson(f: MessageFile): Record<string, unknown> {
  if (f.status === 'used') return { file: f.file, status: 'used', chars: f.chars, changed: new Date(f.mtimeMs).toISOString() };
  if (f.status === 'refused') return { file: f.file, status: 'refused', reason: f.reason };
  return { file: f.file, status: 'absent' };
}

/** `fileJson` plus the placeholders the text uses, for a retro file. */
function retroJson(f: MessageFile): Record<string, unknown> {
  const j = fileJson(f);
  if (f.status !== 'used') return j;
  const needs = [...new Set([...f.text.matchAll(/\{(project|session)\}/g)].map((m) => m[1]))].sort();
  return needs.length > 0 ? { ...j, needs } : j;
}

/** A list of names for one line, escaped, with a count of what was left out. */
function nameList(names: string[], total: number): string {
  const shown = names.slice(0, MESSAGE_NAMES_SHOWN).map(escapeDiskName).join(', ');
  return total > MESSAGE_NAMES_SHOWN ? `${shown}, and ${total - MESSAGE_NAMES_SHOWN} more` : shown;
}

/**
 * Describe the message files in force (issue #539, FR-CONFIG-004), or `null` when there
 * is nothing to say: shown only when the `messages/` folder exists or the home folder is
 * not an absolute path, so a user without one sees the output of before, byte for byte.
 * Read-only: it lists the folder and reads the files, and never creates anything.
 */
export function messagesReport(input: MessagesReportInput): MessagesReport | null {
  const listing = listMessages(input.home, input.nbDir);
  if (!listing.exists && listing.state !== 'home-not-absolute') return null;
  const head = `messages=${MESSAGES_DIR_DISPLAY}`;
  if (listing.state !== 'present') {
    const why =
      listing.state === 'home-not-absolute'
        ? 'the home folder is not an absolute path (HOME is empty or relative), so no message file is read'
        : listing.state === 'inside-nb-dir'
          ? `it lies inside the notebooks folder ${escapeDiskName(listing.nbDir)}, which the shipped scripts sync; move NB_DIR or the notebooks out of the way`
          : `the folder cannot be read (${listing.code})`;
    return {
      lines: [`${head}  (not read: ${why})`],
      json: { path: MESSAGES_DIR_DISPLAY, state: listing.state, reason: why },
    };
  }
  const proj = input.project();
  const set = readMessages(listing, 'brief', proj.name);
  const rset = readMessages(listing, 'retro', proj.name);
  const extra = input.extra();
  const extraText = extra.text;
  const retroTag = (f: MessageFile, noteIfAbsent: string): string => {
    const tag = fileTag(f, noteIfAbsent);
    if (f.status !== 'used') return tag;
    const needs = new Set([...f.text.matchAll(/\{(project|session)\}/g)].map((m) => m[1]));
    if (needs.has('project') && proj.fills === '') return `needs {project}: not added here, no project name found; ${tag.replace(/^in force, /, '')}`;
    return needs.has('session') ? `${tag}; {session} is filled by nb retro, and the block is left out without a session id` : tag;
  };
  // Where the extra prompt's text is the text of a used retro file, the nudge carries it twice.
  const dup = (f: MessageFile | null): boolean => {
    if (f === null || f.status !== 'used' || !extra.set || extra.why !== null) return false;
    if (extraText === f.text) return true;
    if (extra.real === null) return false;
    try {
      return realpathSync(join(listing.dir, f.file)) === extra.real;
    } catch {
      return false;
    }
  };
  const duplicate = dup(rset.global) || dup(rset.project);
  const extraRow = !extra.set
    ? 'retro.env=-  (NB_RETRO_EXTRA_PROMPT is not set)'
    : extra.why !== null
      ? `retro.env=${escapeDiskName(extra.path)}  (env NB_RETRO_EXTRA_PROMPT, not used: ${extra.why})`
      : `retro.env=${escapeDiskName(extra.path)}  (env NB_RETRO_EXTRA_PROMPT, in force, ${[...extraText].length} character${[...extraText].length === 1 ? '' : 's'}; added after the message files${duplicate ? '; the nudge carries it twice' : ''})`;
  const noProjectFile = (kind: 'brief' | 'retro', f: MessageFile | null, tag: (f: MessageFile, n: string) => string): string =>
    f === null
      ? `${kind}.project=-  (${proj.why}${kind === 'retro' && proj.fills !== '' ? '; it still fills {project}' : ''})`
      : `${kind}.project=${f.file}  (${tag(f, `; ${proj.why}`)})`;
  const lines = [
    `${head}  (read by nb brief and nb retro; hooks copied from 0.12 ignore it)`,
    `brief.global=${set.global.file}  (${fileTag(set.global, '')})`,
    noProjectFile('brief', set.project, fileTag),
    `retro.global=${rset.global.file}  (${retroTag(rset.global, '')})`,
    noProjectFile('retro', rset.project, retroTag),
    extraRow,
  ];
  if (listing.ignoredTotal > 0) lines.push(`ignored: ${nameList(listing.ignored, listing.ignoredTotal)}  (not a message file name)`);
  const others = otherProjectFiles(listing, proj.name);
  if (others.length > 0) lines.push(`other projects: ${nameList(others, others.length)}`);
  return {
    lines,
    json: {
      path: MESSAGES_DIR_DISPLAY,
      state: 'present',
      brief: {
        global: fileJson(set.global),
        project: set.project === null ? null : fileJson(set.project),
        projectName: proj.name,
        projectNote: proj.why,
      },
      retro: {
        global: retroJson(rset.global),
        project: rset.project === null ? null : retroJson(rset.project),
        projectName: proj.name,
        projectNote: proj.why,
        fillsProject: proj.fills,
        extra: !extra.set
          ? { status: 'unset' }
          : extra.why !== null
            ? { status: 'refused', path: extra.path, reason: extra.why }
            : { status: 'used', path: extra.path, chars: [...extraText].length, duplicate },
      },
      ignored: listing.ignored,
      ignoredTotal: listing.ignoredTotal,
      otherProjects: others.slice(0, MESSAGE_NAMES_SHOWN),
    },
  };
}
