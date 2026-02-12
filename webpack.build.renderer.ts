import path from "path";
import webpack from "webpack";
import HtmlWebpackPlugin from "html-webpack-plugin";
import { rendererConfig } from "./webpack.renderer.config";

const prodConfig: webpack.Configuration = {
  ...rendererConfig,
  mode: "production",
  target: "web", // 'web' is correct for renderer with contextIsolation: true
  devtool: "source-map",
  entry: "./src/renderer.tsx",
  output: {
    // Matching Forge's structure: .webpack/renderer/main_window
    path: path.join(__dirname, ".webpack/renderer/main_window"),
    filename: "index.js",
    clean: true,
  },
  plugins: [
    ...(rendererConfig.plugins || []),
    new HtmlWebpackPlugin({
      template: "./src/index.html",
    }),
  ],
};

export default prodConfig;
