import type { Configuration } from "webpack";
import path from "path";

import { rules } from "./webpack.rules";
import { plugins } from "./webpack.plugins";

export const mainConfig: Configuration = {
  /**
   * This is the main entry point for your application, it's the first file
   * that runs in the main process.
   */
  entry: "./src/index.ts",
  // Put your normal webpack config below here
  module: {
    rules: [
      ...rules,
      // Add support for native node modules
      {
        // We're specifying native_modules in the test because the asset relocator loader generates a
        // "fake" .node file which is really a cjs file.
        test: /native_modules[/\\].+\.node$/,
        use: "node-loader",
      },
      {
        test: /[/\\]node_modules[/\\].+\.(m?js|node)$/,
        parser: { amd: false },
        use: {
          loader: "@vercel/webpack-asset-relocator-loader",
          options: {
            outputAssetBase: "native_modules",
          },
        },
      },
    ],
  },
  externals: {
    "ffmpeg-static": "commonjs ffmpeg-static",
    "ffprobe-static": "commonjs ffprobe-static",
    "utp-native": "commonjs utp-native",
  },
  plugins,
  resolve: {
    extensions: [".js", ".ts", ".jsx", ".tsx", ".css", ".json"],
    conditionNames: ["node", "require", "import", "default"],
    alias: {
      bitfield$: path.resolve(__dirname, "src/bitfield-compat.js"),
    },
  },
};
