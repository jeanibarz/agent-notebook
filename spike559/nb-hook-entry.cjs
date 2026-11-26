// Candidate entry file for the Claude Code plugin hooks (#559). ES5 only, so any Node that can run a script at all
// can parse it: no arrow, no template string, no let/const, no ??, no ?., no `import(` token (the loader below
// builds it at run time). It reads the minimum Node major from the package's own `engines.node`, and:
//   too old  -> on `session-start` only, print the ASCII notice; nothing for any other event; exit 0
//   ok       -> load the real adapter next to this file (an ES module) and let it run.
'use strict';
var fs = require('fs');
var path = require('path');
var url = require('url');

var event = process.argv[2] || '';

function minimumMajor() {
  var fallback = 18;
  try {
    var pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
    var range = pkg && pkg.engines && pkg.engines.node;
    var m = /(\d+)/.exec(typeof range === 'string' ? range : '');
    return m ? parseInt(m[1], 10) : fallback;
  } catch (e) {
    return fallback;
  }
}

var need = minimumMajor();
var have = parseInt(process.versions.node.split('.')[0], 10);

if (have < need) {
  if (event === 'session-start') {
    process.stdout.write(
      'agent-notebook: Node.js ' + need + ' or later is needed; this one is ' + process.versions.node +
      ', so the notebook is off. Tell the user: install Node.js LTS from https://nodejs.org, then quit and reopen the app.\n'
    );
  }
} else {
  var load = new Function('u', 'return import(u)');
  load(url.pathToFileURL(path.join(__dirname, 'nb-claude-hook.mjs')).href).catch(function (err) {
    process.stderr.write('nb-claude-hook: ' + (err && err.message ? err.message : String(err)) + '\n');
  });
}
