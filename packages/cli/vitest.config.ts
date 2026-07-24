import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Never allow `.only` to ship green, even in environments that don't set
    // CI=true (vitest's own default for `allowOnly` is `!process.env.CI`).
    allowOnly: false,
  },
});
