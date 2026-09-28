# Face ID approvals

Pentacle's iPhone approval key signs the exact daemon-issued lifecycle action. The daemon verifies possession of the operator-confirmed public key. It does not remotely attest Face ID or Secure Enclave hardware.

Face ID unlocks this app. An Approval key lets this phone approve privileged actions requested by Bart. Ordinary sign-in grants no lifecycle authority. Each new approval asks for Face ID. Bart will provide a host code when this is ready. Enrollment input appears only after the current connection receives a snapshot with `capabilities.consent_enrollment_v1: true`; old hosts, disconnects, reconnects before a fresh snapshot and host switches show **Not active yet**. Saved key fingerprints remain visible independently.

Settings → Approval key enrolls the phone using a ten-minute code issued by the loopback host command `agent-orch consent-key enroll-code`. Face ID signs the enrollment transcript; the phone displays a fingerprint in eight groups. Read it and confirm it from the same host with `agent-orch consent-key confirm <fingerprint>`. A pending key cannot approve. A new key does not retire the existing active key until host confirmation.

The consent card displays the action, target and generation, expected revision, requester, audience and remaining time. Approve with Face ID signs the daemon's exact challenge bytes. Deny sends the challenge ID without biometrics. Neither action is queued for automatic reconnect replay. An explicit retry after an ambiguous send reuses only the identical signed tuple. A canceled or expired challenge requires a new request.

The native module uses a P-256 Secure Enclave key with `privateKeyUsage | biometryCurrentSet` and `WhenPasscodeSetThisDeviceOnly`. Each signing operation uses a fresh authentication context with no biometric reuse or passcode fallback. Face ID lockout requires unlocking Face ID before retrying. Changing enrolled Face ID invalidates the key: enroll and confirm a replacement. For a lost phone, revoke the approval fingerprint and operator device credential from a fleet host. An existing lifecycle grant persists until a consented revoke or loopback emergency revoke.

Android approval, web sign-in and App Attest remain outside this implementation. Simulator tests mock the signer; a simulator cannot establish Secure Enclave or Face ID behavior. Run JS tests and typecheck, then the native policy tests:

```sh
npm test -- --runInBand --runTestsByPath tests/privilegedConsent.test.tsx tests/notificationResolveReconnect.test.ts
npm run typecheck
swift test --package-path modules/pentacle-consent --scratch-path <owned-artifact-directory>
```

Physical acceptance uses the signed app on the paired iPhone and records the real consent receipt and audit. Source tests are not physical-device evidence.

The saved key waits for host confirmation and shows active only after its first verified approval receipt. A server refusal or native invalidation makes it unavailable. Sign-in alone never requests re-enrollment. If Bart did not confirm within 10 minutes, ask for a new host code.
