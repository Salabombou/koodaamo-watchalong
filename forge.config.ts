import type { ForgeConfig } from "@electron-forge/shared-types";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { WebpackPlugin } from "@electron-forge/plugin-webpack";

import { mainConfig } from "./webpack.main.config";
import { rendererConfig } from "./webpack.renderer.config";

import path from "path";

const mediaResourcesPath = path.join(process.cwd(), "resources", "bin");

const DEV_CONTENT_SECURITY_POLICY =
  "default-src 'self'; " +
  "base-uri 'self'; " +
  "form-action 'self'; " +
  "frame-ancestors 'none'; " +
  "object-src 'none'; " +
  "script-src 'self' 'unsafe-inline' blob:; " +
  "worker-src 'self' blob:; " +
  "connect-src 'self' http://127.0.0.1:* http://localhost:* http://*:* https://trycloudflare.com https://*.trycloudflare.com https://loca.lt https://*.loca.lt https://localtunnel.me https://*.localtunnel.me; " +
  "img-src 'self' data: blob:; " +
  "media-src 'self' blob: http://127.0.0.1:* http://localhost:* http://*:* https://trycloudflare.com https://*.trycloudflare.com https://loca.lt https://*.loca.lt https://localtunnel.me https://*.localtunnel.me; " +
  "style-src 'self' 'unsafe-inline'; " +
  "style-src-elem 'self' 'unsafe-inline'; " +
  "style-src-attr 'unsafe-inline'; " +
  "font-src 'self' data:";

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    extraResource: [mediaResourcesPath],
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
