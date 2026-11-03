const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const missing = (item) => {
  console.error(`Missing prerequisite: ${item}`);
  process.exit(3);
};
if (Number(process.versions.node.split('.')[0]) < 22) missing('node >= 22');
for (const tool of ['python3', 'tar']) {
  const result = spawnSync(tool, ['--version'], { stdio: 'ignore' });
  if (result.error || result.status !== 0) missing(tool);
}
if (!existsSync('pentacle.config.local.ts')) missing('pentacle.config.local.ts');
