import { defineConfig } from "vite";
import { builtinModules } from "module";

export default defineConfig({
  build: {
    rollupOptions: {
      external: [
        "electron",
        ...builtinModules,
        "webtorrent",
        "utp-native",
        /^node-datachannel/,
        "@achingbrain/nat-port-mapper",
      ],
      output: {
        entryFileNames: "[name].cjs",
      },
    },
  },
});
