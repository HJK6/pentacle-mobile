# Timer Label Diff: FAIL

- scenario: `open_existing_chat_send_host_c_codex`
- stream_id: `hostc:codex-demo`
- max_latency_ms: `120`
- max_allowed_latency_ms: `1500`
- note: Synthetic fixture showing a stale timer label. The source timer reaches 10s while the view still reports 5s.

## Timeline

| daemon_t+ms | stream | daemon_elapsed_s | view_elapsed_s | view_label | latency_ms | status |
|---:|---|---:|---:|---|---:|---|
| 0 | `hostc:codex-demo` | 0 | 0 | Working | 80 | `rendered` |
| 5000 | `hostc:codex-demo` | 5 | 5 | Working | 120 | `rendered` |
| 10000 | `hostc:codex-demo` | 10 |  |  |  | `missing_render` |

## Render Anomalies

| render_t+ms | stream | expected_daemon_elapsed_s | view_elapsed_s | view_label | status |
|---:|---|---:|---:|---|---|
| 10250 | `hostc:codex-demo` | 10 | 5 | Working stale | `stale_render` |

## Interpretation

- `missing_render`: the timer changed, but no matching label render was observed.
- `late_render`: the matching label render arrived after the latency budget.
- `stale_render`: the view rendered an elapsed value different from the latest timer.
- `unbacked_render`: the view rendered before any timer existed for the stream.

