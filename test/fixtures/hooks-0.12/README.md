# The 0.12 Claude Code hook scripts, frozen

These are `examples/hooks/claude-code/nb-*.sh` as they shipped in agent-notebook 0.12,
before issue #538 moved their text into `nb brief` / `nb retro` and their Claude Code
logic into `nb-claude-hook.mjs`. Tests run them to prove the new hooks send the model
the same words, and that an old copied script and the new hooks still nudge once per
session between them. They are test fixtures only and are not in the npm package.
