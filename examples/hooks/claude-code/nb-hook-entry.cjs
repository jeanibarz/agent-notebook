// agent-notebook: the first file a Claude Code plugin hook runs (issue #559).
//
//   node nb-hook-entry.cjs <event> [--managed] [adapter arguments...]
//
// It checks the Node.js version, then hands over to nb-claude-hook.mjs in this folder,
// which does the work. It is written in old JavaScript on purpose (var, function, no
// arrow, no template string, no `??`): a Node.js too old for the adapter must still be
// able to read this file, so that it can say "too old" instead of crashing in silence.
// Node 12 cannot parse the adapter at all, and Node 14 and 16 run it although the
// package needs 18.
//
// With a Node.js older than MIN_NODE it prints NOTICE for session-start, the one event
// whose output the model reads as plain text, and nothing for any other event. Exit 0.
//
// --managed marks a hook block an administrator pasted into managed settings: NB_BIN is
// then ignored, so a project's own settings cannot choose which program the hook runs.
// When this file runs from an installed plugin (CLAUDE_PLUGIN_ROOT contains it), a
// relative NB_BIN is ignored for the same reason; an absolute one is still used.
'use strict';

var path = require('path');

// Keep in step with "engines" in package.json; a test checks both.
var MIN_NODE = 18;
// Shown to the model, which tells the user. ASCII only, and none of ' " $ ` % & | ^ < > ( ) ! ;
// so that the same text can sit inside a sh or PowerShell command; a test checks every copy.
var NOTICE = 'agent-notebook: the notebook needs Node.js 18 or later, which this computer does not have yet. Tell the user, in plain words: Node.js is a free program, download the LTS version from https://nodejs.org and install it, then quit Claude Code completely, with Cmd+Q on a Mac or by closing every terminal window on Windows, and open it again. Until then the notebook is off.';
var BROKEN = 'agent-notebook: the notebook\'s hook could not start. Tell the user: reinstall the agent-notebook plugin.';

var event = process.argv[2] || '';
var off = /^(0|false|no|off)$/i.test(String(process.env.NB_ENABLED || '').trim());

function isStart(e) {
  return e === 'session-start' || e === 'subagent-start';
}

function insidePlugin() {
  var root = process.env.CLAUDE_PLUGIN_ROOT;
  if (!root) return false;
  var rel = path.relative(path.resolve(root), __dirname);
  return rel === '' || (rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel));
}

var major = parseInt(String(process.versions.node).split('.')[0], 10);
if (!(major >= MIN_NODE)) {
  process.stderr.write('nb-hook-entry: Node.js ' + process.versions.node + ' is older than ' + MIN_NODE + '\n');
  if (event === 'session-start' && !off) process.stdout.write(NOTICE + '\n');
} else {
  var managed = process.argv.indexOf('--managed', 3);
  if (managed !== -1) {
    process.argv.splice(managed, 1);
    delete process.env.NB_BIN;
  } else if (insidePlugin() && process.env.NB_BIN && !path.isAbsolute(process.env.NB_BIN.trim())) {
    delete process.env.NB_BIN;
  }
  var adapter = require('url').pathToFileURL(path.join(__dirname, 'nb-claude-hook.mjs')).href;
  // import() is a syntax error before Node 10 and is only reached here, on a Node new
  // enough for the adapter; new Function keeps an old Node from parsing it at all.
  new Function('u', 'return import(u)')(adapter).then(null, function (err) {
    process.stderr.write('nb-hook-entry: ' + (err && err.stack ? err.stack : String(err)) + '\n');
    if (isStart(event) && !off) process.stdout.write(event === 'session-start' ? BROKEN + '\n' : JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: BROKEN } }));
  });
}
