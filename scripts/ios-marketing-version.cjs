#!/usr/bin/env node

require('tsx/cjs');

const { computeAppVersion, computeBuildNumber } = require('../app.config.ts');

const buildNumber = process.argv[2] || computeBuildNumber();

process.stdout.write(`${computeAppVersion(buildNumber)}\n`);
