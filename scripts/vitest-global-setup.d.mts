// Types for vitest-global-setup.mjs so the test type-check (tsconfig.test.json)
// can see its exports instead of treating the module as an implicit `any`.
export function isDistStale(rootDir?: string): boolean;
export default function setup(): void;
