import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      // Resolve the core workspace package to its TypeScript source so unit
      // tests run without a prior `pnpm build` (CI's test job does not build;
      // the package entry points at dist/, which only exists post-build).
      "@infinite-room-labs/claudesync-core": fileURLToPath(
        new URL("../core/src/index.ts", import.meta.url)
      ),
    },
  },
});
