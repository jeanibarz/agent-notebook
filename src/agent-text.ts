/**
 * The words an assistant is told at the end of a task (issue #538).
 *
 * This module holds text only, so it imports nothing: the commands that print it
 * (`nb retro` in `loop.ts`) decide when. The example hooks under
 * `examples/hooks/claude-code/` hold none of it; a test greps them for every line
 * here. Custom text (issue #539) will plug in at this point.
 *
 * `RETRO_LESSONS` is byte for byte the nudge of the 0.12 `nb-retrospective.sh`,
 * so a hook that switches from the script to `nb retro` sends the model the same
 * words.
 */

/** The end-of-task retrospective nudge, one line per element. */
export const RETRO_LESSONS_LINES: readonly string[] = [
  `Before finishing, run the agent-notebook retrospective on the notebooks you opened this task (one pass, then stop):`,
  `  1. nb vote <shelf> <id> +1     — each lesson that actually helped`,
  `  2. nb vote <shelf> <id> -1     — each lesson shown to you that misled (vote takes no --reason)`,
  `  3. nb rm   <shelf> <id> --reason obsolete   — anything incorrect / no longer true`,
  `  4. nb merge/split <shelf> …    — only if lessons repeat or a line holds two`,
  `  5. nb add  <shelf> "<=200-char lesson"   — at MOST one new, non-obvious lesson, to the notebook it fits (or none)`,
  `     Length: aim for ~150 chars / one clause, no preamble — over 200 is rejected, not truncated.`,
  `Do not pad to hit a quota — "nothing new worth storing" is a valid outcome.`,
  `If you are a subagent, end by repeating your full final report after the retrospective: your last message is all your caller receives. Then stop.`,
];

/** The nudge as one string (no trailing newline). */
export const RETRO_LESSONS = RETRO_LESSONS_LINES.join('\n');
