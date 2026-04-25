// eslint.config.js — Flat config (ESLint 9+)
// Impone las fronteras arquitectónicas:
//   channels → application
//   application → domain, persistence
//   domain → (solo sí mismo, sin IO)
//   persistence → (solo sí mismo + infrastructure)
//
// Si un archivo intenta cruzar una frontera prohibida, el linter falla.

import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import boundaries from "eslint-plugin-boundaries";

export default [
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        project: "./tsconfig.json",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      boundaries,
    },
    settings: {
      "boundaries/elements": [
        { type: "channels",       pattern: "src/channels/**" },
        { type: "application",    pattern: "src/application/**" },
        { type: "domain",         pattern: "src/domain/**" },
        { type: "persistence",    pattern: "src/persistence/**" },
        { type: "api",            pattern: "src/api/**" },
        { type: "infrastructure", pattern: "src/infrastructure/**" },
        { type: "config",         pattern: "src/config/**" },
      ],
    },
    rules: {
      // TypeScript
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/consistent-type-imports": "error",

      // Fronteras arquitectónicas (lo importante)
      "boundaries/element-types": ["error", {
        default: "disallow",
        rules: [
          // channels pueden usar application, config, infrastructure
          { from: "channels",    allow: ["application", "domain", "config", "infrastructure"] },

          // application usa domain + persistence + config + infra
          { from: "application", allow: ["domain", "persistence", "config", "infrastructure"] },

          // domain solo sí mismo + config (reglas puras)
          { from: "domain",      allow: ["domain", "config"] },

          // persistence solo sí mismo + config + infra (sin lógica de negocio)
          { from: "persistence", allow: ["persistence", "config", "infrastructure"] },

          // api expone application + domain + config + infra
          { from: "api",         allow: ["application", "domain", "config", "infrastructure"] },

          // infrastructure solo sí mismo + config
          { from: "infrastructure", allow: ["infrastructure", "config"] },

          // config solo sí mismo
          { from: "config",      allow: ["config"] },
        ],
      }],
      "boundaries/no-private": "error",
      "boundaries/no-unknown-files": "warn",
    },
  },
  {
    ignores: ["dist/", "node_modules/", "tests/"],
  },
];
