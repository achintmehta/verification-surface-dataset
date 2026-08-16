// ESLint flat config stub – actual config is in .eslintrc.json
// This file exists for compatibility if a newer ESLint version is used.
import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        EventSource: "readonly",
        document: "readonly",
        fetch: "readonly",
        URL: "readonly",
        HTMLElement: "readonly",
        DragEvent: "readonly",
        Node: "readonly",
        Number: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  {
    ignores: ["node_modules/**", "dist/**", "pgdata/**"],
  },
];
