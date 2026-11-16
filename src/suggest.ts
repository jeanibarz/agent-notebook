/**
 * Did-you-mean suggestions for the CLI (issue #493 moved them here from
 * `cli.ts`): a zero-dependency Levenshtein distance plus a prefix match, used to
 * point a mistyped command, shelf or `NB_*` variable at the nearest real one.
 * Purely advisory: nothing here auto-corrects an input.
 *
 * It imports nothing from `src/`, so the command, shelf and config-report paths
 * can all share it without an import cycle. `closestCommand` stays in `cli.ts`
 * because its default candidate list is the CLI's own `KNOWN_COMMANDS`.
 */

/** Levenshtein edit distance between two strings (zero-dependency, O(a·b)). */
function editDistance(a: string, b: string): number {
  // Single rolling row keeps it allocation-light; command names are tiny.
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

/**
 * Nearest candidate to an unknown input, or `undefined` when nothing is close
 * enough to suggest confidently. Two cheap, zero-dependency signals: a small
 * Levenshtein distance (≤ 2, and strictly under the input length so a 1–2 char
 * stub can't match half the set), or `input` being a prefix of a candidate
 * (≥ 3 chars, catching abbreviations like `desc` → `describe` that edit distance
 * alone would miss). The Levenshtein match wins when both fire; a far-off input
 * matches neither and yields no suggestion. Ties resolve to the EARLIER
 * candidate (strict `<`), so a caller that wants a canonical form preferred over
 * an alias lists it first. Shared by `closestCommand` (over commands, issue
 * #171) and `closestShelf` (over existing shelf names, issue #200).
 */
export function closestMatch(input: string, candidates: readonly string[]): string | undefined {
  const needle = input.trim().toLowerCase();
  if (needle === '') return undefined;
  // An exact candidate is not a typo to recover from (and never reaches the
  // recovery path anyway) — never "suggest" the input back to itself.
  if (candidates.includes(needle)) return undefined;

  let best: string | undefined;
  let bestDist = Infinity;
  for (const cand of candidates) {
    const d = editDistance(needle, cand);
    if (d < bestDist) {
      bestDist = d;
      best = cand;
    }
  }
  // A close typo: within a small edit budget AND not so short that the distance
  // swamps the input (keeps `x`/`ab` from matching an unrelated 2-letter name).
  if (best !== undefined && bestDist <= 2 && bestDist < needle.length) return best;

  // Otherwise an abbreviation: `input` is a prefix of a candidate (first match
  // wins under the caller's ordering), e.g. `desc` → `describe`.
  if (needle.length >= 3) {
    const prefixHit = candidates.find((cand) => cand.startsWith(needle));
    if (prefixHit) return prefixHit;
  }
  return undefined;
}

/**
 * Nearest existing shelf to a mistyped one, or `undefined` when none is close
 * (issue #200). The shelf sibling of `closestCommand`: a mutation that names a
 * shelf which was never created is almost always a typo, so — exactly as an
 * unknown command points at the nearest real command — we point at the nearest
 * real shelf. Purely advisory: it never auto-corrects. Callers pass the live
 * shelf set, `listShelves(dir)` (already sorted, so ties resolve alphabetically).
 */
export function closestShelf(input: string, shelves: readonly string[]): string | undefined {
  return closestMatch(input, shelves);
}
