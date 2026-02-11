import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import pluginReact from "eslint-plugin-react";
import markdown from "@eslint/markdown";
import css from "@eslint/css";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "dist",
      "out",
      ".tmp",
      ".webpack/**",
      "**/.vite",
      "**/node_modules",
      "**/*.d.ts",
      "**/*.config.ts",
      "**/*.config.js",
    ],
  },
  // Javascript/TypeScript Global Config
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    ...js.configs.recommended,
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  // TypeScript Specific
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["**/*.{ts,mts,cts,tsx}"],
  })),
  {
    files: ["**/*.{ts,mts,cts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  // React Specific
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    ...pluginReact.configs.flat.recommended,
    settings: {
      react: {
        version: "detect",
      },
    },
    rules: {
      ...pluginReact.configs.flat.recommended.rules,
      "react/react-in-jsx-scope": "off",
      "react/jsx-uses-react": "off",
    },
  },
  // Markdown
  ...markdown.configs.recommended,
  // CSS
  {
    files: ["**/*.css"],
    plugins: {
      css,
    },
    language: "css/css",
    rules: {
      "css/no-duplicate-imports": "error",
    },
  },
  eslintConfigPrettier,
);
