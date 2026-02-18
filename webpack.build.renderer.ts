import path from "path";
import webpack from "webpack";
import HtmlWebpackPlugin from "html-webpack-plugin";
import { rendererConfig } from "./webpack.renderer.config";

const prodConfig: webpack.Configuration = {
  ...rendererConfig,
  mode: "production",
  target: "web",
  devtool: false,
  entry: "./src/renderer/index.tsx",
  output: {
    path: path.join(__dirname, ".webpack/renderer/main_window"),
    filename: "index.js",
    clean: true,
  },
  optimization: {
    ...(rendererConfig.optimization || {}),
    minimize: true,
    moduleIds: "deterministic",
    chunkIds: "deterministic",
  },
  plugins: [
    ...(rendererConfig.plugins || []),
    new HtmlWebpackPlugin({
      template: "./src/renderer/index.html",
    }),
  ],
};

export default prodConfig;
