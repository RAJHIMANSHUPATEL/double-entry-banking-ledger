import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

// The browser calls /api/... Vite strips that prefix. Fastify routes stay unprefixed,
// and /docs stays on the API origin.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@ledger/money": path.resolve(root, "../src/domain/money.js"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        rewrite: (requestPath) => requestPath.replace(/^\/api/, ""),
      },
    },
  },
});
