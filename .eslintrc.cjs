/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
  },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    project: "./tsconfig.json",
  },
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
  ],
  rules: {
    // Relaxed rules for existing codebase - will tighten over time
    "@typescript-eslint/no-explicit-any": "off",  // TODO: Enable as "warn" and fix
    "@typescript-eslint/no-unused-vars": ["warn", {
      argsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_"
    }],
    "@typescript-eslint/no-require-imports": "off",
    "@typescript-eslint/no-var-requires": "off",
    "@typescript-eslint/ban-ts-comment": "off",
    "no-case-declarations": "off",
    "no-empty": "off",
    "prefer-const": "warn",
    "no-constant-condition": "off",
    "no-fallthrough": "off",  // process.exit() terminates but ESLint doesn't know
    "no-inner-declarations": "off",  // Allow function declarations in blocks

    // Allow console for CLI tool
    "no-console": "off",
  },
  ignorePatterns: [
    "dist/",
    "node_modules/",
    "tests/",
    // Inline *.test.ts files are excluded from tsconfig (see "exclude"), so the
    // type-aware parser (parserOptions.project) cannot parse them — don't lint them,
    // consistent with the tests/ directory already being ignored.
    "src/**/*.test.ts",
    "examples/",
    "docs/",
    "*.js",
    "*.cjs",
    "*.mjs",
  ],
};
