import path from "path";
import webpack from "webpack";
import { mainConfig } from "./webpack.main.config";

const prodConfig: webpack.Configuration = {
  ...mainConfig,
  mode: "production",
  target: "electron-main",
  devtool: "source-map",
  entry: {
    index: "./src/index.ts",
    preload: "./src/preload.ts", // Preload is built here
  },
  output: {
    path: path.join(__dirname, ".webpack/main"),
    filename: "[name].js",
    clean: true,
  },
  // We need to override plugins to inject our own DefinePlugin
  plugins: [
    ...(mainConfig.plugins || []),
    new webpack.DefinePlugin({
      // In production, we assume the renderer is in ../renderer/main_window/index.html relative to main.js
      // We construct a file:// URL for loadURL() compatibility if the code expects a URL
      MAIN_WINDOW_WEBPACK_ENTRY:
        '`file://${require("path").join(__dirname, "../renderer/main_window/index.html")}`',
      MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY:
        'require("path").join(__dirname, "preload.js")',
    }),
  ],
};

export default prodConfig;
