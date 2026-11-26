// Old-Node gate (design-v1 section 4, spike candidate). ES5 only; `import(` exists only inside new Function.
'use strict';
var path = require('path');
var url = require('url');
var MIN_NODE = 18;
var NOTICE = 'agent-notebook: Node.js 18 or later is needed; it is missing or too old here, so the notebook is off. Tell the user: install the LTS version from https://nodejs.org, then quit and reopen Claude Code.';
var event = process.argv[2] || '';
var have = parseInt(process.versions.node.split('.')[0], 10);

if (have < MIN_NODE) {
  if (event === 'session-start') {
    process.stdout.write(NOTICE + '\n');
  } else if (event === 'subagent-start') {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: NOTICE } }) + '\n');
  } else if (event !== 'stop') {
    process.stderr.write(NOTICE + '\n');
    process.exitCode = 1;
  }
} else {
  var load = new Function('u', 'return import(u)');
  load(url.pathToFileURL(path.join(__dirname, 'nb-claude-hook.mjs')).href).catch(function (err) {
    var msg = String(err && err.message ? err.message : err).replace(/\s+/g, ' ').slice(0, 200);
    if (event === 'session-start' || event === 'subagent-start') {
      process.stdout.write('agent-notebook: the ' + event + ' hook could not start (' + msg + '). Tell the user: reinstall the agent-notebook plugin.\n');
    } else {
      process.stderr.write('nb-claude-hook: ' + msg + '\n');
    }
  });
}
