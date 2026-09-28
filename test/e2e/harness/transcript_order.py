"""Reconstruct complete transcript orders from supplied synthetic/local events."""
from types import SimpleNamespace

def transcript_orders(events, target, *, after=0):
    """Accept only complete, unambiguous exact-target order generations."""
    groups = {}
    for event in events:
        d = event.data
        if (event.received_at < after or event.message != 'harness:ui_trace'
                or d.get('kind') != 'transcript_order_chunk' or d.get('stream_id') != target):
            continue
        generation = d.get('order_id')
        if not isinstance(generation, str) or not generation:
            continue
        groups.setdefault(generation, []).append(event)
    complete = []
    for generation, chunks in groups.items():
        count = chunks[0].data.get('row_count')
        if type(count) is not int or count <= 0 or len(chunks) != count:
            continue
        rows = {}
        for chunk in chunks:
            d, offset = chunk.data, chunk.data.get('offset')
            ids = d.get('row_ids')
            if (d.get('row_count') != count or type(offset) is not int
                    or not 0 <= offset < count or offset in rows
                    or not isinstance(ids, list) or len(ids) != 1
                    or not isinstance(ids[0], str) or not ids[0]):
                break
            rows[offset] = ids[0]
        else:
            if len(rows) == count and len(set(rows.values())) == count:
                complete.append(SimpleNamespace(
                    message='harness:ui_trace', received_at=max(c.received_at for c in chunks),
                    data=dict(kind='transcript_order_complete', stream_id=target, order_id=generation,
                              row_order=[{'id': rows[i]} for i in range(count)])))
    return sorted(complete, key=lambda event: event.received_at)
