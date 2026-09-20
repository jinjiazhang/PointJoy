import js from '@eslint/js';
import ts from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import globals from 'globals';

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', 'work/**', '.var/**', 'coverage/**'] },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: globals.node },
    rules: {
      ...js.configs.recommended.rules,
      curly: ['error', 'all'],
      'one-var': ['error', 'never'],
    },
  },
  {
    files: ['**/*.{ts,mts,vue}'],
    languageOptions: { parser: ts.parser },
    plugins: { '@typescript-eslint': ts.plugin },
    rules: {
      ...js.configs.recommended.rules,
      ...ts.configs.eslintRecommended.rules,
      // TypeScript checks names against each workspace's Node / uni-app environment.
      'no-undef': 'off',
      'no-unused-vars': 'off',
      curly: ['error', 'all'],
      'one-var': ['error', 'never'],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          ignoreRestSiblings: true,
          argsIgnorePattern: '^_',
          caughtErrors: 'none',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  ...vue.configs['flat/essential'],
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: ts.parser } },
    rules: { 'vue/multi-word-component-names': 'off' },
  },
];
