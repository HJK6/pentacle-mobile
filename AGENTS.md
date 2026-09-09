# Mobile App — Contributor Guide

This repository contains a standalone Expo / React Native client for a
structured chat stream. Work from the repository root and keep examples,
fixtures, and screenshots synthetic.

Start here by task:

- **Run or extend tests** → [docs/TESTING.md](./docs/TESTING.md). Use the
  focused test first, then the relevant unit and integration checks.
- **Build for a simulator or device** → [docs/PENTACLE_MOBILE_BUILD.md](./docs/PENTACLE_MOBILE_BUILD.md).
- **Understand the event transport** → [docs/CLAUDE_JSONL_TRANSPORT.md](./docs/CLAUDE_JSONL_TRANSPORT.md)
  and [docs/e2e_render_evidence_contract.md](./docs/e2e_render_evidence_contract.md).
- **Use the local simulator loop** → [docs/GHOST_OS_SIMULATOR_WORKFLOW.md](./docs/GHOST_OS_SIMULATOR_WORKFLOW.md).

Before adding a fixture, replace real names, endpoints, identifiers, and
conversation text with stable examples. Do not commit credentials, device
paths, captured production payloads, or private repository links.

## Development loop

Install dependencies with `npm install`, run the smallest relevant test, and
finish with `npm run test:unit` and `npm run typecheck`. Keep changes to the
screen, reducer, and transport layers independently testable.

The session screen should consume normalized events through the shared model.
Do not reconstruct transcript state from terminal buffers in a UI component.
When a new wire field is added, update the type, normalizer, reducer/model
fixture, and render-level assertion together.
