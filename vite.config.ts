import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";
import { execSync } from "node:child_process";

const gitHash = (() => {
  try { return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); }
  catch { return "dev"; }
})();

// GitHub Pages serves from /netcomix/ when using project pages.
// Allow override via env (e.g. for custom domain).
const base = process.env.VITE_BASE ?? "/netcomix/";

export default defineConfig({
  base,
  define: {
    __COMMIT_HASH__: JSON.stringify(gitHash),
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "NetComix",
        short_name: "NetComix",
        description: "Cinematic comic reader with smart panel snapping",
        theme_color: "#0a0a0a",
        background_color: "#0a0a0a",
        display: "standalone",
        orientation: "any",
        start_url: base,
        scope: base,
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Cache comic page images for offline reading
        runtimeCaching: [
          {
            urlPattern: /\/comics\/.*\.(?:jpg|jpeg|png|webp)$/i,
            handler: "CacheFirst",
            options: {
              cacheName: "comic-pages",
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            urlPattern: /\/comics\/.*\.json$/i,
            handler: "StaleWhileRevalidate",
            options: { cacheName: "comic-manifests" },
          },
        ],
      },
    }),
  ],
  server: { port: 5173, host: true },
  preview: { port: 4173, host: true },
});
