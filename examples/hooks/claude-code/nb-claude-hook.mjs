#!/usr/bin/env node
// Claude Code hooks for agent-notebook (issue #538): one adapter for the three events.
//
//   node nb-claude-hook.mjs session-start [--max-chars N]   SessionStart: inject `nb brief`
//   node nb-claude-hook.mjs subagent-start [--max-chars N]  SubagentStart: the same, wrapped for a subagent
//   node nb-claude-hook.mjs stop                            Stop: block once with `nb retro`
//   node nb-claude-hook.mjs print-settings                  print the `hooks` block for settings.json
//
// On a fresh start (session-start, payload `source` startup) run from the plugin, it adds
// `--welcome` to `nb brief` so the set-up note can be printed, unless the user's Claude Code
// settings file mentions hooks copied by hand (see `mentionsCopiedHooks`).
//
// Any start or stop event also takes `--harness <name>` (a-z, 0-9 and -, at most 24
// characters), which names the tool running the hook: the usage log then records
// `<name>.<event>`, e.g. `codex.session-start`. Without it the label is `claude-code`
// when Claude Code's own session id (CLAUDE_CODE_SESSION_ID) equals the payload's,
// and `hook` otherwise.
//
// It holds what knows Claude Code and nothing else: the payload on stdin, which
// stops must not nudge, and the reply format. The words the model reads, and the
// once-per-session rule, belong to `nb brief` and `nb retro`. It never exits 2:
// a Stop hook that exits 2 blocks the stop and feeds its stderr to the model.
// Node only, no shell, so it runs the same on Linux, macOS and Windows.
import { spawnSync } from 'node:child_process';
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The exit status is left at 0 by returning, never by process.exit(): on macOS a
// write to a pipe is asynchronous, and exiting right after it cut the reply short.
main();

function main() {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const [event = '', ...extra] = process.argv.slice(2);

  if (event === 'print-settings') {
    const adapter = join(HERE, 'nb-claude-hook.mjs').replace(/\\/g, '/');
    const hook = (name) => [{ hooks: [{ type: 'command', command: 'node', args: [adapter, name] }] }];
    const hooks = { SessionStart: hook('session-start'), SubagentStart: hook('subagent-start'), Stop: hook('stop') };
    process.stdout.write(JSON.stringify({ hooks }, null, 2) + '\n');
    return;
  }
  if (!['session-start', 'subagent-start', 'stop'].includes(event)) {
    process.stderr.write(`nb-claude-hook: unknown event "${event}" (session-start, subagent-start, stop, print-settings)\n`);
    return;
  }

  let data = {};
  try {
    data = JSON.parse(readFileSync(0, 'utf-8') || '{}') ?? {};
  } catch {
    data = {};
  }

  // Stops that must not nudge (the rules of the 0.12 Stop hook, issue #520): a stop
  // the hook already blocked, a subagent's stop, and a lead waiting for delegated work.
  if (event === 'stop') {
    if (data.stop_hook_active) return;
    if (data.hook_event_name === 'SubagentStop') return;
    if (typeof data.agent_id === 'string' && data.agent_id !== '') return;
    const delegated = new Set(['subagent', 'workflow', 'teammate', 'cloud session']);
    const inFlight = new Set(['running', 'pending']);
    if (
      Array.isArray(data.background_tasks) &&
      data.background_tasks.some((t) => t !== null && typeof t === 'object' && delegated.has(t.type) && inFlight.has(t.status))
    ) {
      return;
    }
  }

  /** An existing absolute directory, else null. */
  function dirOrNull(p) {
    try {
      return typeof p === 'string' && isAbsolute(p) && statSync(p).isDirectory() ? p : null;
    } catch {
      return null;
    }
  }

  /** How to run `nb`: NB_BIN, else the package this file ships in, else `nb` on PATH (not on Windows). */
  function findNb() {
    const asCommand = (file) => (/\.[cm]?js$/.test(file) ? [process.execPath, file] : [file]);
    const bin = (process.env.NB_BIN ?? '').trim();
    // A path is made absolute (`nb` runs in the project directory); a bare name
    // such as the default `nb` is looked up on PATH by the spawn.
    if (bin !== '') return asCommand(/[\\/]/.test(bin) ? resolve(bin) : bin);
    try {
      const root = join(HERE, '..', '..', '..');
      if (JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).name === 'agent-notebook') {
        statSync(join(root, 'dist', 'cli.js'));
        return [process.execPath, join(root, 'dist', 'cli.js')];
      }
    } catch {
      // not inside the installed package (a copied adapter)
    }
    if (process.platform === 'win32') return null;
    for (const d of (process.env.PATH ?? '').split(delimiter)) {
      if (!isAbsolute(d)) continue; // never a relative PATH entry, so never the project's own `nb`
      try {
        if (statSync(join(d, 'nb')).isFile()) return [join(d, 'nb')];
      } catch {
        // not here
      }
    }
    return null;
  }

  // The session id becomes one argument: clean it as `nb` does, and never let it
  // start with `-`, so it cannot be read as a flag (`--json`, `--`).
  const session = (typeof data.session_id === 'string' ? data.session_id : '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128).replace(/^-/, '_');
  const env = { ...process.env };
  // A relative NB_DIR names a folder under this hook's working directory, as it did
  // for the 0.12 scripts; `nb` runs in the project directory, so make it absolute.
  if (env.NB_DIR && env.NB_DIR.trim() !== '' && !env.NB_DIR.startsWith('~') && !isAbsolute(env.NB_DIR)) env.NB_DIR = resolve(env.NB_DIR);

  // The tool's name for the label. An explicit valid `--harness` wins. Without one,
  // Claude Code is recognised by its own session id in the environment equalling the
  // payload's (the raw values, before the cleaning above); any other tool gets `hook`.
  const flag = (name) => (extra.includes(name) ? extra[extra.indexOf(name) + 1] : undefined);
  const named = flag('--harness');
  const harness = typeof named === 'string' && /^[a-z0-9][a-z0-9-]{0,23}$/.test(named) ? named : null;
  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  const inferred = typeof sid === 'string' && sid !== '' && typeof data.session_id === 'string' && sid === data.session_id ? 'claude-code' : 'hook';
  const label = `${harness ?? inferred}.${event}`;
  // The project folder. CLAUDE_PROJECT_DIR is Claude Code's, and a Codex session started
  // from a Claude Code shell inherits it, so only an explicit other `--harness` looks at
  // the payload's `cwd` instead. The inferred label never moves the folder.
  const projectDir =
    harness !== null && harness !== 'claude-code'
      ? (dirOrNull(data.cwd) ?? process.cwd())
      : (dirOrNull(process.env.CLAUDE_PROJECT_DIR) ?? process.cwd());
  const maxChars = flag('--max-chars');
  // The plugin's own start-of-chat step, on a fresh start only, asks `nb brief` for the set-up note
  // (issue #560, D1.1). A person with hooks copied by hand who adds the plugin is not new.
  const inPlugin = insidePlugin();
  const welcome = event === 'session-start' && data.source === 'startup' && inPlugin && !mentionsCopiedHooks();
  const args =
    event === 'stop'
      ? ['retro', '--session', session, '--hook', label, ...(dirOrNull(data.cwd) ? ['--work-dir', data.cwd] : [])]
      : ['brief', '--session', session, '--hook', label, ...(maxChars ? ['--max-chars', maxChars] : []), ...(welcome ? ['--welcome'] : [])];

  const nb = findNb();
  const r = nb ? spawnSync(nb[0], [...nb.slice(1), ...args], { cwd: projectDir, env, encoding: 'utf-8', timeout: 15000, input: '' }) : null;
  // `nb`'s own warnings (a bad NB_RETRO_EXTRA_PROMPT, a skipped shelf) go to the hook log.
  if (r && r.stderr) process.stderr.write(r.stderr);
  let text = r && !r.error && r.status === 0 ? r.stdout : '';
  if (!r || r.error || r.status !== 0) {
    const why = !nb
      ? 'nb was not found'
      : r.error
        ? `nb could not run (${r.error.code ?? r.error.message})`
        : r.status === 2
          ? `this nb is older than the hooks (it has no "${args[0]}" command)`
          : `nb exited ${r.status}`;
    process.stderr.write(`nb-claude-hook: ${why}\n`);
    // A start hook says so to the model, which can tell the user; a Stop hook stays quiet.
    const off = /^(0|false|no|off)$/i.test((process.env.NB_ENABLED ?? '').trim());
    if (event !== 'stop' && !off) {
      // Inside the plugin the program ships with it: the user is told to reinstall, or that it was slow.
      // Outside, the text is what it always was.
      text = inPlugin
        ? r && r.error && r.error.code === 'ETIMEDOUT'
          ? 'agent-notebook: the notebook took too long to start; it will try again next chat.\n'
          : 'agent-notebook: the notebook could not start. Tell the user: reinstall agent-notebook.\n'
        : `agent-notebook: the ${event} hook could not load the notebook index (${why}). Tell the user: install or update agent-notebook (npm i -g agent-notebook), or point NB_BIN at nb.\n`;
    }
  }

  if (text !== '') {
    if (event === 'session-start') process.stdout.write(text);
    else if (event === 'subagent-start') {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: text.replace(/\n$/, '') } }));
    } else process.stdout.write(JSON.stringify({ decision: 'block', reason: text.replace(/\n$/, '') }));
  }
}

/**
 * Whether this file runs from the installed plugin: `CLAUDE_PLUGIN_ROOT` is set and holds this
 * file (the test `nb-hook-entry.cjs` makes, with symlinks resolved). Unlike that file, a root
 * that cannot be resolved counts as "not inside": here being strict only withholds the note.
 */
function insidePlugin() {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (!root) return false;
  try {
    const rel = relative(realpathSync(resolve(root)), realpathSync(dirname(fileURLToPath(import.meta.url))));
    return rel.split(sep)[0] !== '..' && !isAbsolute(rel);
  } catch {
    return false;
  }
}

/**
 * Whether the user's own Claude Code settings file mentions one of the four names of a hook
 * copied by hand (issue #560, D1.1): such a person already has the notebook, so no set-up note.
 * The file is `$CLAUDE_CONFIG_DIR/settings.json` only when that is an absolute local path (one
 * that is relative, or starts with two slashes or two backslashes, a network path, is refused:
 * on Windows opening one can hand the user's credential to that server), else
 * `<home>/.claude/settings.json`. Never `settings.local.json`, a project's or a managed file.
 * Bounded: `lstat`, a regular file of at most 1 MiB, a non-blocking open, one read, a substring
 * test; nothing is parsed, written, printed or passed on. No file is "no": a new user has none.
 * Any other error means `true`, so a failure can only withhold the note, never cause one.
 */
function mentionsCopiedHooks() {
  // The names a hand-copied hook leaves in the settings (inside the function: main() runs before this file's constants are set).
  const names = ['nb-claude-hook', 'nb-session-start', 'nb-retrospective', 'nb-hook-entry'];
  try {
    const cfg = process.env.CLAUDE_CONFIG_DIR;
    let dir;
    if (cfg === undefined || cfg === '') dir = join(homedir(), '.claude');
    else if (!isAbsolute(cfg) || cfg.startsWith('\\\\') || cfg.startsWith('//')) return true;
    else dir = cfg;
    const file = join(dir, 'settings.json');
    let st;
    try {
      st = lstatSync(file);
    } catch (e) {
      return !(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR'));
    }
    const MAX = 1024 * 1024;
    if (!st.isFile() || st.size > MAX) return true;
    const fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const fst = fstatSync(fd);
      if (!fst.isFile() || fst.size > MAX) return true;
      const buf = Buffer.alloc(fst.size);
      let got = 0;
      while (got < buf.length) {
        const n = readSync(fd, buf, got, buf.length - got, got);
        if (n === 0) break;
        got += n;
      }
      const text = buf.toString('utf-8', 0, got);
      return names.some((name) => text.includes(name));
    } finally {
      closeSync(fd);
    }
  } catch {
    return true;
  }
}
