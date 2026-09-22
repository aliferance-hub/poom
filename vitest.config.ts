import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: { alias: { "@": path.resolve(root, "src") } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    // P2-F (F12): the suite is DB-backed and some files temporarily mutate shared
    // registry state (asset lifecycle swaps the ACTIVE version); parallel files
    // would read each other's intermediate state. Run files sequentially.
    fileParallelism: false,
  },
});
