'use strict';

// The shared reporter is optional on a public checkout. Forward Jest's actual
// callbacks when installed; do not replace a failing installed reporter with a no-op.
const path = require('node:path');
class TesttimeReporter {
  constructor(...args) {
    const configured = process.env.TESTTIME_JEST_REPORTER;
    if (!configured) return;
    let resolved;
    try { resolved = require.resolve(path.resolve(configured)); }
    catch (error) { if (error.code === 'MODULE_NOT_FOUND') return; throw error; }
    const implementation = require(resolved);
    const Reporter = implementation.default || implementation;
    this.delegate = new Reporter(...args);
  }
}
for (const method of ['onRunStart', 'onTestStart', 'onTestCaseStart', 'onTestCaseResult', 'onTestResult', 'onRunComplete', 'getLastError']) {
  TesttimeReporter.prototype[method] = function (...args) {
    return this.delegate?.[method]?.(...args);
  };
}
module.exports = TesttimeReporter;
