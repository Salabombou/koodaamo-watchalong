import type { ForgeConfig } from "@electron-forge/shared-types";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { WebpackPlugin } from "@electron-forge/plugin-webpack";

import { mainConfig } from "./webpack.main.config";
import { rendererConfig } from "./webpack.renderer.config";

import { createRequire } from "module";

const require = createRequire(import.meta.url);
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;

const DEV_CONTENT_SECURITY_POLICY =
  "default-src 'self'; " +
  "base-uri 'self'; " +
  "form-action 'self'; " +
  "frame-ancestors 'none'; " +
  "object-src 'none'; " +
  "script-src 'self' 'unsafe-inline' blob:; " +
  "worker-src 'self' blob:; " +
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:* http://127.0.0.1:* http://localhost:*; " +
  "img-src 'self' data: blob:; " +
  "media-src 'self' blob: http://127.0.0.1:* http://localhost:*; " +
  "style-src 'self' 'unsafe-inline'; " +
  "style-src-elem 'self' 'unsafe-inline'; " +
  "style-src-attr 'unsafe-inline'; " +
  "font-src 'self' data:";

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    extraResource: [ffmpegPath, ffprobePath],
  },
  rebuildConfig: {},
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new WebpackPlugin({
      mainConfig,
      devContentSecurityPolicy: DEV_CONTENT_SECURITY_POLICY,
      renderer: {
        config: rendererConfig,
        entryPoints: [
          {
            html: "./src/renderer/index.html",
            js: "./src/renderer/index.tsx",
            name: "main_window",
            preload: {
              js: "./src/main/preload.ts",
            },
          },
        ],
      },
    }),
  ],
};

export default config;
