import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.CLAUDEBOT_API_URL ?? "http://127.0.0.1:18790";
  const hmrPath = "/__claudebot_vite_hmr";

  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    build: {
      outDir: path.resolve(__dirname, "dist"),
      emptyOutDir: true,
      sourcemap: false,
    },
    server: {
      host: "0.0.0.0",
      port: 5173,
      strictPort: true,
      // Keep Vite's HMR socket on a dedicated path. Claudebot's app WebSocket is
      // opened directly from the browser to the gateway, so the dev server
      // should never proxy WebSocket upgrades.
      hmr: {
        path: hmrPath,
      },
      proxy: {
        "/webui": { target, changeOrigin: true },
        "/api": { target, changeOrigin: true },
        "/auth": { target, changeOrigin: true },
      },
    },
    test: {
      environment: "happy-dom",
      globals: true,
      setupFiles: ["./src/tests/setup.ts"],
    },
  };
});
