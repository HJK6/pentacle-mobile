import { mapLayout } from '../../../src/components/lanes/lanesRingLayout';

test.each([375, 390, 430])('map at %i wide: hub is an inner ring, centred on the ring circle, links end on both edges', width => {
  for (const count of [1, 6, 7, 8]) {
    const map = mapLayout(count, 4, width);
    expect([map.hub, map.size, map.radius]).toEqual(count > 6 ? [46, 46, 116] : [52, 52, 108]);
    expect(map.cx).toBe(width / 2);
    for (const [i, point] of map.inner.entries()) {
      expect(Math.hypot(point.x - map.cx, point.y - map.cy)).toBeCloseTo(map.radius, 6);
      const { from, to } = map.links[i];
      expect(Math.hypot(from.x - map.cx, from.y - map.cy)).toBeCloseTo(map.hub / 2, 6);
      expect(Math.hypot(to.x - point.x, to.y - point.y)).toBeCloseTo(map.size / 2, 6);
    }
    expect(map.outer).toHaveLength(4);
    expect(map.outer[0].x).toBe(map.outer[2].x);
    expect(map.outer[1].x).toBe(map.outer[3].x);
    expect(map.outer[0].x + map.outer[1].x).toBe(width);
  }
});


test.each([320, 375, 390, 430])('every outer lane has a distinct in-bounds position at %i', width => {
  for (const count of [5, 9, 13, 20]) {
    const map = mapLayout(8, count, width);
    expect(map.outer).toHaveLength(count);
    expect(new Set(map.outer.map(p => `${p.x},${p.y}`)).size).toBe(count);
    for (const p of map.outer) {
      expect(p.x - 42).toBeGreaterThanOrEqual(0);
      expect(p.x + 42).toBeLessThanOrEqual(width);
      expect(p.y - 15).toBeGreaterThanOrEqual(0);
      expect(p.y + 46).toBeLessThan(map.height);
    }
  }
});
