import js from "@eslint/js";
import tseslint from "typescript-eslint";

const nodeGlobals = {
  Buffer: "readonly",
  URL: "readonly",
  console: "readonly",
  process: "readonly",
};

export default tseslint.config(
  {
    ignores: ["dist/**", "drizzle/**", "node_modules/**", "data/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: { globals: nodeGlobals },
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
);
