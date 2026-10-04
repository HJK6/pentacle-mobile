# Managed chat files

The existing image viewer remains unchanged. Non-image attachments use a named
file bubble with canonical type and size, plus an explicit Save or share action.
Unsupported types and incomplete historical metadata are inert.

Every file action fetches through the existing authenticated blob RPC. It checks
the declared and returned size, returned digest and actual SHA256 before writing
a private operation-specific cache file. Disk bytes are read back and verified
before the native share sheet opens. Event-supplied URIs and old cache files
cannot bypass a new authorized fetch. Only that operation's temporary directory
is cleaned afterward. Files are not executed, extracted or embedded in the chat.

`blob_unknown` shows "File expired or unavailable" and disables the action.
Other failures remain retryable. Single-flight and unmount cancellation prevent
repeated or stale native share prompts. Completion of the OS share sheet is not
reported as proof that a user saved a copy.

Supported downloads: PDF, ZIP, 3MF, STL, STEP/STP and OpenSCAD. PNG/JPEG continue
through the existing image path. Managed metadata adds filename, size and upload_id
to the existing shared type. The targeted ASSIST_TEXT attachment exemption fixes
empty-caption file replies in live/history/snapshot ingestion without replacing
other mobile-specific shared-core behavior.

Native capability: expo-sharing 14.0.8 is the Expo SDK 54 supported version.
It is loaded only when a user requests a file action. A native build containing
the module is needed for sharing; JavaScript export alone is not native/device
qualification. Older binaries report unavailable sharing instead of failing
ordinary image rendering during module import.

## Validation and handoff

Run the focused attachment suites, `npm run test:unit`, `npm run typecheck`, and
`npm run validate` using the ignored synthetic example config. Existing CI is
unchanged. Linux native-guard fixtures need real Ruby and BSD tar as configured
by the existing CI; missing tools or GNU-tar path semantics are environment
failures, not reasons to weaken the guards.

The simulator gate is documented in `test/e2e/file_delivery/README.md`. Unit
mocks and an iOS JavaScript export do not establish native save/share, installed
artifact or physical-device acceptance.

This work uses an unchanged-commit, base-relative git bundle for fleet publication.
The fleet verifies ancestry in an isolated public checkout, runs local gates and
the real authenticated pre-push hook, then opens a draft PR. Do not bypass the
history guard, rewrite the handed-off commits, merge or deploy this package.
