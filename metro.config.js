/**
 * Metro config for Wildside (Expo SDK 57 + React Native 0.86.3).
 *
 * On this machine, Metro 0.86.x resolves the Node core module `buffer` for
 * `react-native-svg/src/utils/fetchData.ts`. That fails because the native React
 * runtime has no Node stdlib. The Expo default metro-config already blacklists
 * several Node core modules, but `buffer` slips through for this react-native-svg
 * version. We extend the resolver blockList to drop these Node core modules from
 * resolution so Metro never tries to bundle them.
 */
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver = config.resolver || {};
config.resolver.blockList = config.resolver.blockList || [];

// Node core modules that must not be resolved for the React Native runtime.
const nodeCoreModules = [
  'buffer',
  'process',
  '__filename',
  '__dirname',
  'module',
  'require',
  'node:buffer',
  'node:process',
];

const nodeCorePatterns = nodeCoreModules.map(function (m) {
  return new RegExp('^' + m + '$');
});

config.resolver.blockList = config.resolver.blockList.concat(nodeCorePatterns);

module.exports = config;
