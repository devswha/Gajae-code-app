import { readFileSync } from 'node:fs';

import js from '@eslint/js';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import boundaries from 'eslint-plugin-boundaries';
import { createNodeResolver, importX } from 'eslint-plugin-import-x';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tailwindcss from 'eslint-plugin-tailwindcss';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const engineFiles = JSON.parse(readFileSync(new URL('./server/gjc-engine-manifest.json', import.meta.url), 'utf8')).engine;
const importGroups = ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'];
const nodeExtensions = ['.mjs', '.cjs', '.js', '.json', '.node', '.ts', '.tsx'];

function orderingRules() {
  return {
    'import-x/no-duplicates': 'error',
    'import-x/no-cycle': 'error',
    'import-x/order': ['error', { groups: importGroups, 'newlines-between': 'always' }],
  };
}

function unusedVariableRules() {
  return {
    'unused-imports/no-unused-imports': 'error',
    'unused-imports/no-unused-vars': ['error', {
      vars: 'all',
      varsIgnorePattern: '^_',
      args: 'after-used',
      argsIgnorePattern: '^_',
    }],
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': 'off',
  };
}

function recommendedConfig(files, plugins, languageOptions, rules, settings = undefined) {
  return {
    files,
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    plugins,
    languageOptions,
    ...(settings === undefined ? {} : { settings }),
    rules,
  };
}

const browserConfig = recommendedConfig(
  ['src/**/*.{ts,tsx,js,jsx}'],
  {
    react,
    'react-hooks': reactHooks,
    'react-refresh': reactRefresh,
    'import-x': importX,
    tailwindcss,
    'unused-imports': unusedImports,
  },
  { globals: { ...globals.browser }, parserOptions: { ecmaFeatures: { jsx: true } } },
  {
    ...unusedVariableRules(),
    ...orderingRules(),
    'react/jsx-key': 'error',
    'react/jsx-no-duplicate-props': 'error',
    'react/jsx-no-undef': 'error',
    'react/no-children-prop': 'error',
    'react/no-danger-with-children': 'error',
    'react/no-direct-mutation-state': 'error',
    'react/no-unknown-property': 'error',
    'react/react-in-jsx-scope': 'off',
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'error',
    'react-refresh/only-export-components': 'off',
    'tailwindcss/classnames-order': 'error',
    'tailwindcss/no-contradicting-classname': 'error',
    'tailwindcss/no-unnecessary-arbitrary-value': 'error',
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-require-imports': 'off',
    'no-case-declarations': 'off',
    'no-control-regex': 'off',
    'no-useless-escape': 'off',
  },
  { react: { version: 'detect' }, tailwindcss: { cssConfigPath: './src/index.css' } },
);

const backendElements = [
  { type: 'gjc-engine-api', pattern: ['server/gjc-engine.ts'], mode: 'file' },
  { type: 'gjc-engine-client', pattern: ['server/gjc-worker-client.ts'], mode: 'file' },
  { type: 'gjc-engine', pattern: engineFiles, mode: 'file' },
  {
    type: 'backend-shared-type-contract',
    pattern: ['server/shared/types.{js,ts}', 'server/shared/interfaces.{js,ts}'],
    mode: 'file',
  },
  {
    type: 'backend-shared-utils',
    pattern: [
      'server/shared/utils.{js,ts}',
      'server/shared/frontmatter.ts',
      'server/shared/claude-cli-path.ts',
      'server/shared/image-attachments.ts',
      'server/shared/tool-output-transport.ts',
      'server/shared/request-origin.ts',
      'server/shared/desktop-internal-activity.ts',
      'server/middleware/desktop-auth.js',
      'server/middleware/auth.js',
    ],
    mode: 'file',
  },
  {
    type: 'backend-legacy-runtime',
    pattern: ['server/projects.js', 'server/utils/runtime-paths.js'],
    mode: 'file',
  },
  {
    type: 'backend-module',
    pattern: 'server/modules/*',
    mode: 'folder',
    capture: ['moduleName'],
  },
];

function backendSettings() {
  const typescript = { project: ['server/tsconfig.json'], alwaysTryTypes: true };
  const node = { extensions: nodeExtensions };
  return {
    'boundaries/include': ['server/**/*.{js,ts}'],
    'boundaries/elements': backendElements,
    'import/resolver': { typescript, node },
    'import-x/resolver-next': [
      createTypeScriptImportResolver(typescript),
      createNodeResolver(node),
    ],
  };
}

const boundaryRules = [
  {
    from: { type: 'backend-module' },
    to: { type: 'backend-shared-type-contract' },
    disallow: { dependency: { kind: ['value', 'typeof'] } },
    message: 'Backend modules may only use `import type` when importing from server/shared/types.ts or server/shared/interfaces.ts.',
  },
  {
    to: { type: 'backend-module' },
    disallow: { to: { internalPath: '**' } },
    message: 'Cross-module imports must go through that module\'s barrel file (server/modules/<module>/index.ts or index.js).',
  },
  {
    to: { type: 'backend-module' },
    allow: { to: { internalPath: ['index', 'index.{js,mjs,cjs,ts,tsx}'] } },
  },
  {
    from: { type: 'gjc-engine' },
    disallow: { to: { type: ['backend-module', 'backend-legacy-runtime'] } },
    message: 'The GJC engine may not import the app around it, barrel included. Move the shared piece next to the engine, or pass it through server/gjc-worker-protocol.ts.',
  },
  {
    from: { type: ['backend-module', 'gjc-engine-client'] },
    disallow: { to: { type: 'gjc-engine' } },
    message: 'Import the engine through server/gjc-engine.ts. Its exports are the published surface; if what you need is missing, export it there deliberately.',
  },
];

const serverConfig = {
  ...recommendedConfig(
    ['server/**/*.{js,ts}'],
    { boundaries, 'import-x': importX, 'unused-imports': unusedImports },
    {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
      globals: { ...globals.node },
    },
    {
      ...orderingRules(),
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-control-regex': 'off',
      'no-useless-escape': 'off',
      'import-x/no-unresolved': 'error',
      'import-x/no-useless-path-segments': 'error',
      'import-x/no-absolute-path': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'boundaries/dependencies': ['error', {
        default: 'allow',
        checkInternals: false,
        rules: boundaryRules,
      }],
      'boundaries/no-unknown': 'error',
    },
    backendSettings(),
  ),
  ignores: ['server/**/*.d.ts'],
};

const toolingConfig = recommendedConfig(
  ['shared/**/*.{js,cjs,mjs,ts}', 'scripts/**/*.{js,cjs,mjs,ts}', 'vite.config.js'],
  { 'import-x': importX, 'unused-imports': unusedImports },
  { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node, ...globals.browser } },
  {
    ...unusedVariableRules(),
    ...orderingRules(),
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-require-imports': 'off',
    'no-control-regex': 'off',
  },
);

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'public/**'] },
  browserConfig,
  serverConfig,
  toolingConfig,
);
