const base = require('../../package.json').jest;
module.exports = {
  ...base,
  rootDir: '../..',
  testMatch: ['<rootDir>/test/daemon-pinned/journey.ts'],
  testPathIgnorePatterns: [],
};
