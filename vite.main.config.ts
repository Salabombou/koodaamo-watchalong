import { defineConfig } from "vite";
import { builtinModules } from "module";

export default defineConfig({
  build: {
    rollupOptions: {
      external: [
        "electron",
        ...builtinModules,
        "webtorrent",
        "../../../build/Release/node_datachannel.node",
      ],
      output: {
        entryFileNames: "[name].cjs",
      },
    },
  },
});
