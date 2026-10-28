'use strict';

const DOMAIN = 'com.apple.generativeexperiences.corefollowup';
const KEY = 'DateOfLastAppleIntelligenceReadinessCFU';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

// Called by the simulator creator before installing the app. No bound-simulator adoption.
function configureCfu({ owner, udid, deviceSet, census, run, now = new Date() }) {
  const record = { udid, requested: now.toISOString().slice(0, 19).replace('T', ' ') + ' +0000', readback: null, verified: false, operations: [] };
  const matches = Array.isArray(census) ? census.filter(d => d.udid === udid) : [];
  if (!owner || !UUID.test(udid || '') || owner.createdUdid !== udid || !owner.name ||
      !deviceSet || owner.deviceSet !== deviceSet || matches.length !== 1 ||
      matches[0].name !== owner.name || matches[0].state !== 'Booted') {
    record.error = 'simulator ownership not verified'; return record;
  }
  function command(args, timeout = 120000) {
    try {
      const r = run(args, timeout);
      const rc = Number.isInteger(r.status) ? r.status : null;
      record.operations.push({ action: args, rc });
      return { rc, stdout: typeof r.stdout === 'string' ? r.stdout : '' };
    } catch (error) {
      record.operations.push({ action: args, rc: null, error: String(error.message || error) });
      return { rc: null, stdout: '' };
    }
  }
  const write = command(['spawn', udid, 'defaults', 'write', DOMAIN, KEY, '-date', record.requested]);
  if (write.rc !== 0) { record.error = 'write failed'; return record; }
  const shutdown = command(['shutdown', udid]);
  const boot = command(['boot', udid]);
  const ready = command(['bootstatus', udid, '-b'], 300000);
  if (shutdown.rc !== 0 || boot.rc !== 0 || ready.rc !== 0) { record.error = 'shutdown or reboot failed'; return record; }
  const read = command(['spawn', udid, 'defaults', 'read', DOMAIN, KEY]);
  record.readback = read.stdout.trim();
  record.verified = read.rc === 0 && record.readback === record.requested;
  if (!record.verified) record.error = 'readback failed or differed';
  return record;
}
module.exports = { configureCfu };
