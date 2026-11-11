// Types for check-node-for-tests.mjs so the test type-check (tsconfig.test.json)
// can see its exports instead of treating the module as an implicit `any`.
export const MIN_TEST_NODE: string;
export const UNSUPPORTED_MESSAGE: string;
export function nodeSupportsTests(version: string): boolean;
