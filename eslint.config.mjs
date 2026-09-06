import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**"],
  },
  {
    files: ["src/**/*.ts", "test/**/*.ts", "tools/**/*.ts", "tools/**/*.mts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
  },
);
