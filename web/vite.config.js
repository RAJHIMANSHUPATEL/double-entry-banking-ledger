import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));
const apiTarget = process.env.API_PROXY_TARGET || "http://127.0.0.1:3000";

// The browser calls /api/... Vite strips that prefix. Fastify routes stay unprefixed,
// and /docs stays on the API origin. Compose sets API_PROXY_TARGET to the api service.
const apiProxy = {
  "/api": {
    target: apiTarget,
    rewrite: (requestPath) => requestPath.replace(/^\/api/, ""),
  },
};

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@ledger/money": path.resolve(root, "../src/domain/money.js"),
    },
  },
  server: {
    port: 5173,
    proxy: apiProxy,
  },
  preview: {
    host: "0.0.0.0",
    port: 8080,
    proxy: apiProxy,
  },
});
