module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  env: { es2022: true, node: true, browser: true },
  parserOptions: { sourceType: "module", ecmaVersion: 2022 },
  rules: {
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "@typescript-eslint/no-explicit-any": "off",
    "no-constant-condition": ["error", { checkLoops: false }],
    "prefer-const": ["error", { destructuring: "all" }]
  },
  ignorePatterns: ["dist", "coverage", "node_modules", "*.cjs"]
};
