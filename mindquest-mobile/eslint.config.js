// ESLint for the app's own code (run: npx eslint src).
// eslint-config-expo knows JSX, React Native globals and the .android.js files.
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', '.expo/*', 'node_modules/*']
  }
]);
