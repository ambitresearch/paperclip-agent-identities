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
  },
});
