import path from "path";
import webpack from "webpack";
import { mainConfig } from "./webpack.main.config";

const mainProcessConfig: webpack.Configuration = {
  ...mainConfig,
  mode: "production",
  target: "electron-main",
  devtool: false,
  entry: {
    index: "./src/main/index.ts",
    preload: "./src/main/preload.ts",
  },
  output: {
    path: path.join(__dirname, ".webpack/main"),
    filename: "[name].js",
    clean: true,
  },
  optimization: {
    ...(mainConfig.optimization || {}),
    minimize: true,
    moduleIds: "deterministic",
    chunkIds: "deterministic",
  },
  plugins: [
    ...(mainConfig.plugins || []),
    new webpack.DefinePlugin({
      MAIN_WINDOW_WEBPACK_ENTRY:
        '`file://${require("path").join(__dirname, "../renderer/main_window/index.html")}`',
      MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY:
        'require("path").join(__dirname, "preload.js")',
    }),
  ],
};

const preloadConfig: webpack.Configuration = {
  ...mainConfig,
  mode: "production",
  target: "electron-preload",
  devtool: false,
  entry: {
    preload: "./src/main/preload.ts",
  },
  output: {
    path: path.join(__dirname, ".webpack/main"),
    filename: "[name].js",
    clean: false,
  },
  optimization: {
    ...(mainConfig.optimization || {}),
    minimize: true,
    moduleIds: "deterministic",
    chunkIds: "deterministic",
  },
  plugins: [...(mainConfig.plugins || [])],
};

export default [mainProcessConfig, preloadConfig];
