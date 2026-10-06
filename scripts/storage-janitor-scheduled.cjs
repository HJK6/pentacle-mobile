'use strict';

// Entry point of the scheduled LaunchAgent. It runs the fixed `storage:janitor dry-run` and keeps the
// last two runs of stdout/stderr under State/logs: 1 MiB per file, four files, 4 MiB inside the 64 MiB
// state budget. Each file keeps its head and its tail, with a marker for the dropped middle, and
// stderr always ends with one run marker. It accepts no path or mode, and a capture failure never
// stops or masks the job.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { fixedLayout } = require('./storage-authority.cjs');

const LOG_CAP_BYTES = 1024 * 1024;
const RESERVE_BYTES = 512;
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = LOG_CAP_BYTES - RESERVE_BYTES - HEAD_BYTES;
const LOG_NAME = /^janitor\.(stdout|stderr)\.log(\.1)?$/;
const FIXED_ARGUMENTS = ['storage:janitor', 'dry-run'];

function writeAll(descriptor, buffer) {
  let offset = 0;
  while (offset < buffer.length) offset += fs.writeSync(descriptor, buffer, offset, buffer.length - offset);
}

class Capture {
  constructor(descriptor) { this.descriptor = descriptor; this.head = 0; this.tail = Buffer.alloc(0); this.dropped = 0; this.failed = false; }

  push(chunk) {
    if (this.failed) return;
    try {
      let rest = chunk;
      if (this.head < HEAD_BYTES) {
        const take = Math.min(HEAD_BYTES - this.head, chunk.length);
        writeAll(this.descriptor, chunk.subarray(0, take));
        this.head += take;
        rest = chunk.subarray(take);
      }
      if (!rest.length) return;
      this.tail = Buffer.concat([this.tail, rest]);
      if (this.tail.length > TAIL_BYTES) {
        this.dropped += this.tail.length - TAIL_BYTES;
        this.tail = this.tail.subarray(this.tail.length - TAIL_BYTES);
      }
    } catch { this.failed = true; }
  }

  finish(footer) {
    try {
      if (!this.failed) {
        if (this.dropped) writeAll(this.descriptor, Buffer.from(`\n[pentacle-janitor-log truncated: ${this.dropped} bytes dropped, cap ${LOG_CAP_BYTES}]\n`));
        writeAll(this.descriptor, this.tail);
      }
      if (footer) writeAll(this.descriptor, Buffer.from(this.failed ? `${footer.slice(0, -2)} capture=degraded]\n` : footer));
    } catch { this.failed = true; }
    try { fs.closeSync(this.descriptor); } catch { this.failed = true; }
  }
}

function openLogs(state) {
  const directory = path.join(state, 'logs');
  const existing = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!existing) fs.mkdirSync(directory, { mode: 0o700 });
  else if (!existing.isDirectory() || existing.isSymbolicLink()) throw Object.assign(new Error('LOGS_NOT_DIRECTORY'), { code: 'ENOTDIR' });
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  return ['janitor.stdout.log', 'janitor.stderr.log'].map((name) => {
    if (!LOG_NAME.test(name)) throw new Error('LOG_NAME');
    const current = path.join(directory, name);
    const prior = fs.lstatSync(current, { throwIfNoEntry: false });
    if (prior) {
      if (!prior.isFile() || prior.isSymbolicLink()) throw Object.assign(new Error('LOG_NOT_FILE'), { code: 'EEXIST' });
      fs.renameSync(current, `${current}.1`);
    }
    return new Capture(fs.openSync(current, flags, 0o600));
  });
}

function run({ state = fixedLayout().state, command = process.execPath, args = [path.join(__dirname, 'storage-cli.cjs'), ...FIXED_ARGUMENTS], cwd = path.resolve(__dirname, '..'), env = process.env } = {}) {
  const stamp = () => new Date().toISOString();
  let captures = null;
  try { captures = openLogs(state); }
  catch (error) { process.stderr.write(`[pentacle-janitor-run capture-failed ${error.code || 'ERROR'} at=${stamp()}]\n`); }
  return new Promise((resolve) => {
    let done = false;
    let child;
    try { child = spawn(command, args, { cwd, env, stdio: ['ignore', captures ? 'pipe' : 'inherit', captures ? 'pipe' : 'inherit'] }); }
    catch (error) { child = null; settle({ error }); }
    if (!child) return;
    if (captures) { child.stdout.on('data', (chunk) => captures[0].push(chunk)); child.stderr.on('data', (chunk) => captures[1].push(chunk)); }
    child.on('error', (error) => settle({ error }));
    child.on('close', (code, signal) => settle({ code, signal }));
    function settle(result) {
      if (done) return;
      done = true;
      const footer = result.error
        ? `[pentacle-janitor-run spawn-failed ${result.error.code || 'ERROR'} at=${stamp()}]\n`
        : `[pentacle-janitor-run exit=${result.code ?? 'none'} signal=${result.signal ?? 'none'} at=${stamp()}]\n`;
      if (captures) { captures[0].finish(null); captures[1].finish(footer); }
      resolve(result.error || result.code === null ? 1 : result.code);
    }
  });
}

if (require.main === module) {
  const received = process.argv.slice(2);
  if (received.length !== FIXED_ARGUMENTS.length || received.some((value, index) => value !== FIXED_ARGUMENTS[index])) {
    process.stderr.write('JANITOR_WRAPPER_ARGUMENTS\n');
    process.exit(2);
  }
  run().then((status) => process.exit(status));
}

module.exports = { LOG_CAP_BYTES, LOG_NAME, run };
