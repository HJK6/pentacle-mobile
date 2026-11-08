export type RingPoint = { x: number; y: number; angle: number };
/** Clockwise from the top. Fixed single-line label boxes are disjoint at six. */
export function innerRingPoints(
  count: number,
  width: number,
  height: number,
  selected = 0,
): RingPoint[] {
  const radius = Math.max(36, Math.min((width - 112) / 2, (height - 108) / 2));
  const cx = width / 2,
    cy = height / 2 - 14;
  return Array.from({ length: count }, (_, i) => {
    const angle =
      -Math.PI / 2 + (2 * Math.PI * (i - selected)) / Math.max(1, count);
    return {
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
      angle,
    };
  });
}
/** The bottom 90 degrees stays clear of the sheet and lower labels. */
export function outerRingPoints(
  count: number,
  width: number,
  height: number,
): RingPoint[] {
  const radiusX = Math.max(24, width / 2 - 22),
    radiusY = Math.max(24, height / 2 - 24);
  return Array.from({ length: count }, (_, i) => {
    const angle =
      Math.PI * 0.75 + (Math.PI * 1.5 * (i + 0.5)) / Math.max(1, count);
    return {
      x: width / 2 + radiusX * Math.cos(angle),
      y: height / 2 - 14 + radiusY * Math.sin(angle),
      angle,
    };
  });
}
