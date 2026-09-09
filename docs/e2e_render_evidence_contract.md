# Mobile Render-Evidence Contract

Transport events arriving is not proof that the intended content reached the
screen. Every chat transcript walk must assert a content-bearing render event.

## Rendered reply oracle

The authoritative beacon is `harness:row_rendered` with
`lifecycle: "mount"`. It should be emitted by the session screen with a
display rule, row kind, and bounded text prefix. A reply is an assistant row
whose display rule is `bubble:assistant` or the provider's documented divider
rule. The event must occur after the send anchor.

Do not accept transport counters such as `chat:event_received` or
`chat:event_rendered` as reply evidence by themselves. A test may use
`chat:transcript_row_rendered` as an equivalent mount-only beacon when a
platform adapter provides it.

## Send and open walks

Each send/open scenario calls the shared render-evidence assertion with its
stream id and provider. The assertion requires a mounted assistant row after
`chat.compose.optimistic_insert` (or an explicitly supplied send timestamp).
It returns a structured `(ok, error, info)` result for the verdict artifact.

## Landing evidence

`harness:transcript_ready_settled` may have a timeout fallback and therefore is
not sufficient alone. Corroborate it with at least one mounted row or
`chat:history_backfill_rendered`. A timeout with no content-bearing row is a
failure, even if the transport counters look healthy.

## Question walks

Question scenarios assert exact rendered card counts, option counts, and free
text counts. Option taps update local state; the explicit submit action is the
only resolve action. After submit, require a mounted assistant reply rather
than merely any event arrival. Synthetic question records should use stable
example labels and no captured conversation text.

## Negative proof

Each closed regression should have a synthetic trace that fails when the
assistant mount is omitted and passes when it is present. Keep the proof in the
test suite, use fake events and streams, and do not modify production code just
to satisfy the assertion.

## Rule for new walks

> A new chat-transcript walk MUST assert render-level, content-bearing evidence
> carrying the expected assistant display rule or content digest. Event
> counters and timeout-backed readiness are not proof that the right content
> rendered.

Record evidence as artifact paths and verdict JSON. Do not paste captured
transcripts into source or documentation.
