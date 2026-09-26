import {consentTelemetry} from '../src/services/privilegedConsent';
jest.mock('../modules/pentacle-consent', () => ({nativeConsentSigner: jest.fn()}));
jest.mock('../src/services/pentacleStream', () => ({sendConsentCommand: jest.fn()}));
const host = globalThis as unknown as {nativeLoggingHook?: (line: string, level: number) => void};
const originalHook = host.nativeLoggingHook;
afterEach(() => {host.nativeLoggingHook = originalHook; jest.restoreAllMocks();});
function expectedLine() {return '[TELEMETRY] ' + JSON.stringify({subsystem:'consent',message:'consent.card_rendered',bug_ref:'mobile_faceid_privileged_consent_2026_09',data:{challenge_id:'fixture'}});}
test('production consent emits tagged telemetry to native logger without harness sink', () => {
  const hook = jest.fn(); host.nativeLoggingHook = hook;
  const log = jest.spyOn(console,'log').mockImplementation(()=>{});
  consentTelemetry('card_rendered', {challenge_id:'fixture'});
  expect(hook).toHaveBeenCalledWith(expectedLine(), 2);
  expect(log).not.toHaveBeenCalled();
});
test('consent emits the same tagged envelope when native logger is absent', () => {
  delete host.nativeLoggingHook;
  const log = jest.spyOn(console,'log').mockImplementation(()=>{});
  consentTelemetry('card_rendered', {challenge_id:'fixture'});
  expect(log).toHaveBeenCalledWith(expectedLine());
});
