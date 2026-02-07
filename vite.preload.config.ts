import { defineConfig } from "vite";
import { builtinModules } from "module";

export default defineConfig({
  build: {
    rollupOptions: {
      external: ["electron", ...builtinModules, "webtorrent", "@roamhq/wrtc"],
      output: {
        entryFileNames: "[name].cjs",
      },
    },
  },
});
