'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function requirePluginIntegrity(root) {
  const relative = 'plugins/withHarnessLaunchUrl.js';
  const expected = require('./storage-authority.cjs').CERTIFIED_COMPONENTS[relative];
  let actual;
  try { actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex'); } catch {}
  if (!actual || actual !== expected) throw new Error(`CERTIFIED_COMPONENT_DRIFT:${relative}:expected=${expected}:actual=${actual || 'missing'}`);
}

const { requireHostHealth } = require('./gate-host-health.cjs');

function beforeBootstrap(root, bootstrap, health = requireHostHealth) {
  const { collectChecks, requireChecks } = require('./gate-checks.cjs');
  const checks = collectChecks([
    { name: 'plugin-drift', run: () => requirePluginIntegrity(root) },
    { name: 'hostadmission-and-signal', run: health },
  ]);
  requireChecks(checks);
  return bootstrap(checks[1].value);
}

module.exports = { beforeBootstrap, requirePluginIntegrity, requireHostHealth };
