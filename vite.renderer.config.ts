import { defineConfig } from "vite";
import { builtinModules } from "module";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      external: ["electron", ...builtinModules, "webtorrent", "@roamhq/wrtc"],
    },
  },
});
