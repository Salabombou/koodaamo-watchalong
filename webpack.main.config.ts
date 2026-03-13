import type { Configuration } from "webpack";
import path from "path";

import { rules } from "./webpack.rules";
import { plugins } from "./webpack.plugins";

export const mainConfig: Configuration = {
  /**
   * This is the main entry point for your application, it's the first file
   * that runs in the main process.
   */
  entry: "./src/main/index.ts",
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
    "utp-native": "commonjs utp-native",
  },
  plugins,
  resolve: {
    extensions: [".js", ".ts", ".jsx", ".tsx", ".css", ".json"],
    conditionNames: ["node", "require", "import", "default"],
    alias: {
      "@shared": path.resolve(__dirname, "src/shared"),
      "@controllers": path.resolve(__dirname, "src/main/controllers"),
      "@protocols": path.resolve(__dirname, "src/main/protocols"),
      "@services": path.resolve(__dirname, "src/main/services"),
      "@@types": path.resolve(__dirname, "src/main/types"),
      "@utilities": path.resolve(__dirname, "src/main/utilities"),
    },
  },
};
