'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fixedLayout } = require('./storage-authority.cjs');
const { readAuthorityState } = require('./storage-state.cjs');

function named(name, code, fields) {
  const detail = Object.entries(fields).map(([key, value]) => `${key}=${value}`).join(';');
  const error = new Error(`${code}:${detail};action=npm run storage:janitor -- dry-run`);
  error.name = name;
  return error;
}

function parseStartInterval(plist) {
  if (typeof plist !== 'string') throw named('JanitorScheduleInvalidError', 'JANITOR_SCHEDULE_INVALID', { reason: 'not-text' });
  const matches = [...plist.matchAll(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/g)];
  const interval = matches.length === 1 ? Number(matches[0][1]) : NaN;
  if (!Number.isSafeInteger(interval) || interval <= 0) throw named('JanitorScheduleInvalidError', 'JANITOR_SCHEDULE_INVALID', { reason: 'StartInterval' });
  return interval;
}

function validateReport(entry) {
  const value = entry?.value;
  const completed = Date.parse(value?.completed_at);
  if (!entry || entry.filename !== `${value?.report_id}.json` || value?.schema !== 1 || !Array.isArray(value?.errors) || !Number.isFinite(completed)) {
    throw named('JanitorReportInvalidError', 'JANITOR_REPORT_INVALID', { report: entry?.filename || 'unknown' });
  }
  return { ...entry, completed };
}

function evaluateJanitorHealth({ now = Date.now(), installedAt, plist, reports }) {
  if (!Number.isFinite(now) || !Number.isFinite(Date.parse(installedAt)) || !Array.isArray(reports)) {
    throw named('JanitorHealthInputError', 'JANITOR_HEALTH_INPUT_INVALID', { reason: 'clock-or-reports' });
  }
  const interval = parseStartInterval(plist);
  const threshold = interval * 2;
  const installedAge = Math.max(0, Math.floor((now - Date.parse(installedAt)) / 1000));
  const validated = reports.map(validateReport).sort((left, right) => right.completed - left.completed);
  if (!validated.length) {
    if (installedAge <= threshold) return { status: 'fresh-install', interval_seconds: interval, threshold_seconds: threshold, age_seconds: installedAge };
    throw named('JanitorNeverLaunchedError', 'JANITOR_NEVER_LAUNCHED', { stale_seconds: installedAge, threshold_seconds: threshold });
  }
  const newest = validated[0];
  const age = Math.floor((now - newest.completed) / 1000);
  if (age < 0) throw named('JanitorReportInvalidError', 'JANITOR_REPORT_INVALID', { report: newest.filename, reason: 'future-clock' });
  if (newest.value.errors.length) throw named('JanitorLastRunFailedError', 'JANITOR_LAST_RUN_FAILED', { report: newest.value.report_id, errors: newest.value.errors.length, stale_seconds: age });
  if (age > threshold) throw named('JanitorOverdueError', 'JANITOR_REPORT_OVERDUE', { report: newest.value.report_id, stale_seconds: age, threshold_seconds: threshold });
  return { status: 'healthy', report_id: newest.value.report_id, interval_seconds: interval, threshold_seconds: threshold, age_seconds: age };
}

function readReports(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => name.endsWith('.json')).map((filename) => {
    const target = path.join(directory, filename);
    let value;
    try { value = JSON.parse(fs.readFileSync(target, 'utf8')); }
    catch { throw named('JanitorReportInvalidError', 'JANITOR_REPORT_INVALID', { report: filename, reason: 'unreadable' }); }
    return { filename, value };
  });
}

function requireJanitorHealthy(now = Date.now()) {
  const layout = fixedLayout();
  let plist;
  try { plist = fs.readFileSync(layout.launchAgent, 'utf8'); }
  catch { throw named('JanitorScheduleInvalidError', 'JANITOR_SCHEDULE_INVALID', { reason: 'installed-config-unreadable' }); }
  return evaluateJanitorHealth({
    now,
    installedAt: readAuthorityState().created_at,
    plist,
    reports: readReports(path.join(layout.state, 'reports')),
  });
}

module.exports = { evaluateJanitorHealth, parseStartInterval, requireJanitorHealthy };
