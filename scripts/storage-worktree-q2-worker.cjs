'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const realExec = childProcess.execFileSync;
const realSpawn = childProcess.spawnSync;
const mode = process.argv[2] || 'race';
fs.statfsSync = () => ({ blocks: 1n, bsize: 4096n });
const mutationCapability = require('./storage-capability.cjs').claim();
const { fixedLayout } = require('./storage-authority.cjs');
const state = require('./storage-state.cjs');
const stateMutations = state.bind(mutationCapability);
const worktreeModule = require('./storage-worktrees.cjs');
const { STATUSES } = worktreeModule;

const layout = fixedLayout();
const lane = 'pentacle-mobile__q2';
const sourceName = mode === 'mismatch-folder' ? 'pentacle-mobile__other' : lane;
const declaredBranch = mode === 'mismatch-branch' ? 'fix/other' : `fix/${lane}`;
const ownerStatus = mode === 'nonterminal-register' ? 'in_progress' : 'completed';
const worktree = path.join(layout.worktrees, lane);
const statfsPreload = path.join(process.env.HOME, 'storage-test-statfs.cjs');
fs.writeFileSync(statfsPreload, "require('node:fs').statfsSync = () => ({ blocks: 1n, bsize: 4096n });\n");
const run = (args, cwd) => realExec('/usr/bin/git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const finish = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
for (const target of [layout.support, layout.stateImage, layout.state, layout.worktrees, layout.memory, ...Object.values(layout.repositories)]) fs.mkdirSync(target, { recursive: true, mode: 0o700 });
for (const status of STATUSES) fs.mkdirSync(path.join(layout.memory, 'work', status), { recursive: true, mode: 0o700 });

function sidecar(id, type, name, status, folderName, body = '', branch = declaredBranch) {
  const branchField = branch === null ? '' : `branch: ${branch}\n`;
  return `---\nid: ${id}\ntitle: Q2\ntype: ${type}\nstatus: ${status}\ncanonical: false\ncreated_at: '2026-07-17'\nupdated_at: '2026-07-17'\nsource_path: work/${status}/${folderName}/${name}\nmachine: hosta\nowner: test\ntags:\n- storage\nsummary: Q2 fixture\nrelated: []\n${branchField}---\n${body}`;
}

const source = path.join(layout.memory, 'work', ownerStatus, sourceName);
fs.mkdirSync(source, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(source, 'spec.md'), sidecar('spec_q2', 'spec', 'spec.md', ownerStatus, sourceName));
fs.writeFileSync(path.join(source, 'summary.md'), sidecar('work_q2', mode === 'invalid-type' ? 'work_summary' : 'work', 'summary.md', ownerStatus, sourceName, '', mode === 'missing-summary-branch' ? null : declaredBranch));
const remote = path.join(process.env.HOME, 'remote.git');
run(['init', '--bare', remote], process.env.HOME);
const repository = layout.repositories['pentacle-mobile'];
run(['init', '-b', 'main'], repository);
run(['config', 'user.email', 'q2@example.invalid'], repository);
run(['config', 'user.name', 'Q2'], repository);
fs.writeFileSync(path.join(repository, 'seed.txt'), 'seed\n');
run(['add', 'seed.txt'], repository);
run(['commit', '-m', 'seed'], repository);
run(['remote', 'add', 'origin', remote], repository);
run(['push', '-u', 'origin', 'main'], repository);
run(['worktree', 'add', '-b', `fix/${lane}`, worktree], repository);
run(['push', '-u', 'origin', `fix/${lane}`], worktree);
stateMutations.createInstalledAuthority();
let ticketId;
try {
  const output = realExec(process.execPath, [path.join(__dirname, 'storage-cli.cjs'), 'storage:register-worktree', 'pentacle-mobile', 'spec_q2', lane], { cwd: __dirname, env: { ...process.env, NODE_OPTIONS: `--require=${statfsPreload}` }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  ticketId = JSON.parse(output).id;
}
catch (error) { finish({ registration_blocked: true, reason: String(error.stderr || error.message || error) }); }
if (['invalid-type', 'nonterminal-register', 'mismatch-folder', 'mismatch-branch', 'missing-summary-branch'].includes(mode)) finish({ registration_blocked: false, reason: '' });

function createReference() {
  const referenceName = 'pentacle-mobile__reference';
  const reference = path.join(layout.memory, 'work', 'in_progress', referenceName);
  fs.mkdirSync(reference, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(reference, 'spec.md'), sidecar('spec_reference', 'spec', 'spec.md', 'in_progress', referenceName, 'spec_q2\n'));
  fs.writeFileSync(path.join(reference, 'summary.md'), sidecar('work_reference', 'work', 'summary.md', 'in_progress', referenceName));
}
if (mode === 'reference') createReference();

const observation = { locks: [], no_force: false };
childProcess.spawnSync = function intercepted(binary, args, options) {
  const directRemoval = binary === '/usr/bin/git' && args[0] === '-C' && args.includes('worktree') && args.includes('remove');
  const lockedHelper = binary === process.execPath && args[0] === path.join(__dirname, 'storage-worktrees.cjs') && args[1] === '__remove_locked';
  if (directRemoval || lockedHelper) {
    const gitDirectory = run(['rev-parse', '--path-format=absolute', '--git-dir'], worktree).trim();
    const commonDirectory = run(['rev-parse', '--path-format=absolute', '--git-common-dir'], worktree).trim();
    const branchRef = run(['symbolic-ref', 'HEAD'], worktree).trim();
    observation.locks = [path.join(commonDirectory, `${branchRef}.lock`), path.join(gitDirectory, 'HEAD.lock'), path.join(gitDirectory, 'index.lock')].map((target) => fs.existsSync(target));
    observation.no_force = !args.includes('--force') && !args.includes('-f');
    if (mode === 'race') realExec('/usr/bin/git', ['-C', worktree, 'commit', '--allow-empty', '-m', `race-${crypto.randomUUID()}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (mode === 'source-drift') createReference();
  }
  if (lockedHelper) {
    options = { ...options, env: { ...options.env, NODE_OPTIONS: `${options.env.NODE_OPTIONS || ''} --require=${statfsPreload}`.trim() } };
  }
  return realSpawn(binary, args, options);
};
delete require.cache[require.resolve('./storage-worktrees.cjs')];
let blocked = false;
let blockedError = '';
try { require('./storage-worktrees.cjs').bind(mutationCapability).retireWorktree(ticketId, Date.now() + 86400001); }
catch (error) { blocked = true; blockedError = String(error.message || error); }
const ticket = state.readRecord('tickets', ticketId);
finish({ blocked, retained: fs.existsSync(worktree), state: ticket.state, reason: ticket.blocked_reason || blockedError, locks: observation.locks, no_force: observation.no_force });
