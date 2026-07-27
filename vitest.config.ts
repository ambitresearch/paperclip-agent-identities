import { defineConfig } from "vitest/config";

// Vitest's default process.env.NODE_ENV is "test", but this repo's runner
// invocation (`npm test`) can inherit an ambient NODE_ENV=production from the
// shell, which makes React resolve its production build -- and
// react/react-dom's `act()` (used by the .spec.tsx interaction tests) is only
// exported from the development build. Force it here so `act` is always
// available regardless of the ambient environment.
process.env.NODE_ENV = "test";

export default defineConfig({
  test: {
    // Includes both plain .spec.ts (node environment, default below) and
    // .spec.tsx interaction tests (jsdom, set per-file via a
    // `// @vitest-environment jsdom` comment so the global default here stays
    // "node" for everything else).
    include: ["tests/**/*.spec.ts", "tests/**/*.spec.tsx"],
    environment: "node",
    // Raised from Vitest's 5000ms default because that budget is spent on fork
    // scheduling delay, not on the tests themselves. The three jsdom files
    // above cost ~14s each to instantiate an environment (~42s aggregate). A
    // developer machine has enough cores to absorb that concurrently, but a
    // 4-core CI runner does not: while those forks saturate the box, unrelated
    // node-environment tests sit runnable-but-unscheduled and trip the default
    // timeout. That surfaced as `tests/providers/slack/ingress-worker-
    // integration.spec.ts` intermittently failing three tests in CI while the
    // whole file completes in ~700ms locally -- and it blocked a release,
    // because `publish.yml` runs the suite before publishing.
    //
    // This is headroom for starvation, not permission to be slow: a genuinely
    // hung test never completes, so it still fails here. If a test needs
    // anywhere near 15s of real work, that is a bug in the test.
    testTimeout: 15_000,
  },
});
