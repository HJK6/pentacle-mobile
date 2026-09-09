# Timer Label Diff: PASS

- scenario: `open_existing_chat_send_host_c_codex`
- stream_id: `hostc:codex-demo`
- max_latency_ms: `180`
- max_allowed_latency_ms: `1500`
- note: Synthetic fixture showing a consistent timer/label run. Every timer change has a matching label render.

## Timeline

| daemon_t+ms | stream | daemon_elapsed_s | view_elapsed_s | view_label | latency_ms | status |
|---:|---|---:|---:|---|---:|---|
| 0 | `hostc:codex-demo` | 0 | 0 | Working | 120 | `rendered` |
| 5000 | `hostc:codex-demo` | 5 | 5 | Working | 180 | `rendered` |
| 10000 | `hostc:codex-demo` | 10 | 10 | Working | 160 | `rendered` |

## Interpretation

- `missing_render`: the timer changed, but no matching label render was observed.
- `late_render`: the matching label render arrived after the latency budget.
- `stale_render`: the view rendered an elapsed value different from the latest timer.
- `unbacked_render`: the view rendered before any timer existed for the stream.

