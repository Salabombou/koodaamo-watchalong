import { defineConfig } from "vite";
import { builtinModules } from "module";

export default defineConfig({
  build: {
    rollupOptions: {
      external: [
        "electron",
        ...builtinModules,
        "webtorrent",
        "ffmpeg-static",
        "ffprobe-static",
        "electron-squirrel-startup",
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
