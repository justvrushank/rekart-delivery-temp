import { defineConfig } from "vitest/config";

// Standalone vitest config (does NOT extend vite.config.ts, so the React Router
// plugin isn't loaded for unit tests). Server-side logic runs in the node env.
export default defineConfig({
  test: {
    environment: "node",
    include: ["app/**/*.test.ts"],
  },
});
