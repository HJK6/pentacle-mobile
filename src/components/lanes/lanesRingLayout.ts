export type MapPoint = { x: number; y: number };
export const MAP_HEIGHT = 404;
const CENTRE_Y = 190;

/**
 * One fixed drawing so links and icons always line up. Up to six inner lanes use 52 point rings on a 108 point
 * circle, seven or eight use 46 on 116. The hub is the size of an inner ring; links run edge to edge.
 */
export function mapLayout(innerCount: number, outerCount: number, width: number) {
  const many = innerCount > 6, radius = many ? 116 : 108, size = many ? 46 : 52, hub = size;
  const topRows = Math.max(1, Math.ceil(outerCount / 4)), topCount = Math.min(outerCount, topRows * 2);
  const bottomRows = Math.ceil((outerCount - topCount) / 2), rowHeight = 64;
  const shift = (topRows - 1) * rowHeight;
  const cx = width / 2, cy = CENTRE_Y + shift;
  const inner = Array.from({ length: innerCount }, (_, i): MapPoint => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / innerCount;
    return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
  });
  // Grow the quiet corner rows above and below the ring without hiding lanes or shrinking targets.
  const inset = Math.min(143, cx - 46);
  const outer = Array.from({ length: outerCount }, (_, i): MapPoint => {
    const top = i < topCount, index = top ? i : i - topCount;
    return { x: cx + (index % 2 ? inset : -inset),
      y: (top ? 40 : 334 + shift) + Math.floor(index / 2) * rowHeight };
  });
  const links = inner.map(point => {
    const d = Math.hypot(point.x - cx, point.y - cy), ux = (point.x - cx) / d, uy = (point.y - cy) / d;
    return { from: { x: cx + ux * hub / 2, y: cy + uy * hub / 2 }, to: { x: point.x - ux * size / 2, y: point.y - uy * size / 2 } };
  });
  return { cx, cy, radius, size, hub, many, height: MAP_HEIGHT + shift + Math.max(0, bottomRows - 1) * rowHeight, inner, outer, links };
}
