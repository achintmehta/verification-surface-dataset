export default [
  {
    files: ['**/*.js'],
    ignores: ['node_modules/**', 'dist/**', 'data/**'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      'no-unused-vars': 'warn',
      'no-undef': 'off',
    },
  },
];
