#!/usr/bin/env node
// Marketing versions are computed by the app configuration from the build
// number. This compatibility entrypoint keeps the release command from editing
// version files or creating tags.

const level = (process.argv[2] || 'minor').toLowerCase();
if (!['major', 'minor', 'patch'].includes(level)) {
  console.error(`Usage: node scripts/release.mjs <major|minor|patch> (got "${level}")`);
  process.exit(1);
}

console.log('Mobile app versions are automatic at build time.');
console.log(`To build with the ${level.toUpperCase()} lane:`);
console.log(`APP_VERSION_BUMP=${level} npm run ios:device`);
