export type MapPoint = { x: number; y: number };
export const MAP_HEIGHT = 404;
const CENTRE_Y = 190;

/**
 * One fixed drawing so links and icons always line up. Up to six inner lanes use 52 point rings on a 108 point
 * circle, seven or eight use 46 on 116. The hub is the size of an inner ring; links run edge to edge.
 */
export function mapLayout(innerCount: number, outerCount: number, width: number) {
  const many = innerCount > 6, radius = many ? 116 : 108, size = many ? 46 : 52, hub = size;
  const cx = width / 2, cy = CENTRE_Y;
  const inner = Array.from({ length: innerCount }, (_, i): MapPoint => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / innerCount;
    return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
  });
  // Corners keep the mock's 390 point drawing, centred, so spacing is the same at every width.
  const slots: MapPoint[] = [{ x: cx - 143, y: 40 }, { x: cx + 143, y: 40 }, { x: cx - 143, y: 334 }, { x: cx + 143, y: 334 }];
  const links = inner.map(point => {
    const d = Math.hypot(point.x - cx, point.y - cy), ux = (point.x - cx) / d, uy = (point.y - cy) / d;
    return { from: { x: cx + ux * hub / 2, y: cy + uy * hub / 2 }, to: { x: point.x - ux * size / 2, y: point.y - uy * size / 2 } };
  });
  return { cx, cy, radius, size, hub, many, height: MAP_HEIGHT, inner, outer: slots.slice(0, outerCount), links };
}
