import { innerBox, mapLayout, outerBox, ringedMapLayout, type MapBox, type MapName } from '../../../src/components/lanes/lanesRingLayout';
import { MAP_REAL_LANES, mapScenario } from '../../../src/harness/lanesMapScenarios';

const WIDTHS = [375, 390, 402, 430, 440];
const BUSY = [0, 1, 2, 4, 6, 7, 9, 12, 16, 30];
const QUIET = [0, 3, 9, 14, 24, 40];
const LONG = 'Implementation documentation';
const overlap = (a: MapBox, b: MapBox) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/** The scenario lanes: inner lanes keep the fixture titles; with `long`, every third outer lane gets a long two-word title. */
function lanes(busy: number, quiet: number, long: boolean) {
  const all = mapScenario(busy, quiet).filter(l => l.cls !== 'parked').map((l, i): MapName & { hours: number } =>
    ({ id: `l${i}`, title: long && i >= Math.min(busy, 6) && i % 3 === 2 ? LONG : l.title, hours: l.hours }));
  const inner = all.slice(0, Math.min(busy, 6)), extra = all.slice(Math.min(busy, 6), busy);
  // Quiet lanes arrive most recent first, as the core helper orders them.
  const quietLanes = all.slice(busy).map((l, i) => ({ l, i })).sort((a, b) => a.l.hours - b.l.hours || a.i - b.i).map(x => x.l);
  return { inner, extra, quiet: quietLanes };
}

test.each([375, 390, 430, 440])('single-ring map at %i wide is the approved one: 52 point rings on a 108 circle, links edge to edge', width => {
  for (let count = 1; count <= 6; count++) {
    const map = mapLayout(count, width);
    expect([map.hub, map.size, map.radius, map.cx, map.cy, map.height]).toEqual([52, 52, 108, width / 2, 190, 404]);
    expect(map.inner[0].x).toBeCloseTo(width / 2, 9);
    expect(map.inner[0].y).toBeCloseTo(190 - 108, 9);
    for (const [i, point] of map.inner.entries()) {
      expect(Math.hypot(point.x - map.cx, point.y - map.cy)).toBeCloseTo(108, 6);
      const { from, to } = map.links[i];
      expect(Math.hypot(from.x - map.cx, from.y - map.cy)).toBeCloseTo(26, 6);
      expect(Math.hypot(to.x - point.x, to.y - point.y)).toBeCloseTo(26, 6);
    }
  }
});

test('box estimates follow the approved nodeBox and ringBox constants', () => {
  expect(innerBox(0, 0, 'Pentacle mobile')).toEqual([-49, -23, 49, 23 + 4 + 2 * 14 + 12]);
  expect(innerBox(0, 0, 'J3')).toEqual([-23, -23, 23, 23 + 4 + 14 + 12]);
  expect(outerBox(0, 0, 'J3')).toEqual([-20, -20, 20, 20 + 3 + 13]);
  expect(outerBox(0, 0, LONG)).toEqual([-39, -20, 39, 20 + 3 + 2 * 13]);
  expect(outerBox(10, 10)).toEqual([-10, -10, 30, 30]);
});

describe.each(WIDTHS)('two-circle map at %i wide', width => {
  test.each(BUSY)('busy %i crossed with every quiet count, fixture and long titles', busy => {
    for (const quietCount of QUIET) for (const long of [false, true]) {
      if (!quietCount && busy <= 6) continue;
      const { inner, extra, quiet } = lanes(busy, quietCount, long);
      const map = ringedMapLayout(inner, extra, quiet, width);
      const at = `${width} ${busy}+${quietCount}${long ? ' long' : ''}`;
      // Inner geometry: the fixed ring size, radius and first lane at 12 o'clock.
      const radius = inner.length <= 4 ? 94 : inner.length === 5 ? 96 : 98;
      expect([map.size, map.hub, map.radius, map.cx]).toEqual([46, 46, radius, width / 2]);
      for (const [i, p] of map.inner.entries()) {
        const angle = -Math.PI / 2 + 2 * Math.PI * i / inner.length;
        expect(p.x).toBeCloseTo(map.cx + radius * Math.cos(angle), 9);
        expect(p.y).toBeCloseTo(map.cy + radius * Math.sin(angle), 9);
      }
      // Height is the content plus 18 above and below.
      const parts = [...map.innerBoxes, ...map.outer.map(o => o.box), [0, map.cy - 23, 0, map.cy + 23] as MapBox];
      expect(Math.min(...parts.map(b => b[1]))).toBeCloseTo(18, 9);
      expect(Math.max(...parts.map(b => b[3]))).toBeCloseTo(map.height - 18, 9);
      expect(map.outer.length).toBeGreaterThan(0);
      for (const [i, o] of map.outer.entries()) {
        // Concentric: every outer node sits on the outer radius round the hub.
        expect(Math.hypot(o.x - map.cx, o.y - map.cy)).toBeCloseTo(map.outerRadius, 6);
        expect(o.box[0]).toBeGreaterThanOrEqual(0);
        expect(o.box[2]).toBeLessThanOrEqual(width);
        for (const f of map.innerBoxes) if (overlap(o.box, f)) throw new Error(`${at}: outer ${i} overlaps an inner lane`);
        for (const p of map.outer.slice(i + 1)) if (overlap(o.box, p.box)) throw new Error(`${at}: outer ${i} overlaps another outer node`);
      }
      // Every lane is placed by name or counted in exactly one +N, and the counts add up.
      const placed = map.outer.flatMap(o => o.kind === 'lane' ? [o.id] : []);
      const more = map.outer.flatMap(o => o.kind === 'more' ? [o] : []);
      const counted = more.flatMap(o => o.ids);
      expect([...placed, ...counted].sort()).toEqual([...extra, ...quiet].map(l => l.id).sort());
      expect(new Set(more.map(o => o.tone)).size).toBe(more.length);
      // Busy lanes come first: a busy lane folds only when no quiet lane is placed, and then into the green +N.
      const busyPlaced = placed.filter(id => extra.some(l => l.id === id)), quietPlaced = placed.filter(id => quiet.some(l => l.id === id));
      if (busyPlaced.length < extra.length) {
        expect(quietPlaced).toEqual([]);
        expect(more.find(o => o.tone === 'busy')!.ids).toEqual(extra.slice(busyPlaced.length).map(l => l.id));
      }
      for (const o of map.outer) if (o.kind === 'lane') expect(o.busy).toBe(extra.some(l => l.id === o.id));
      // Placed quiet lanes are the most recent ones; the muted +N holds the rest.
      expect(quietPlaced.sort()).toEqual(quiet.slice(0, quietPlaced.length).map(l => l.id).sort());
      if (quietPlaced.length < quiet.length) expect(more.find(o => o.tone === 'quiet')!.ids).toEqual(quiet.slice(quietPlaced.length).map(l => l.id));
    }
  });
});

const named = (ls: readonly { title: string }[]) => ls.map((l, i) => ({ id: `l${i}`, title: l.title }));
test('real mix at 440: Pentacle mobile and Government contracts inside, all nine quiet lanes named on the circle, no +N', () => {
  const real = MAP_REAL_LANES.filter(l => l.cls !== 'parked');
  const inner = named(real).filter((_, i) => real[i].cls === 'moving');
  const order = ['Pentacle', 'Business acquisition', '3D printing', 'Hosts and accounts', 'Altum CRM and phone', 'J3', 'Personal', 'Altum Automations', 'Animation'];
  const quiet = order.map(title => ({ id: title, title }));
  expect(inner.map(l => l.title)).toEqual(['Pentacle mobile', 'Government contracts']);
  const map = ringedMapLayout(inner, [], quiet, 440);
  expect(map.outer.filter(o => o.kind === 'more')).toEqual([]);
  expect(map.outer.map(o => o.kind === 'lane' && o.id).sort()).toEqual([...order].sort());
});

test('12 busy + 9 quiet at 440: all six outer busy lanes are placed; unplaced quiet lanes are in the muted +N', () => {
  const { inner, extra, quiet } = lanes(12, 9, false);
  const map = ringedMapLayout(inner, extra, quiet, 440);
  expect(map.outer.filter(o => o.kind === 'lane' && o.busy)).toHaveLength(6);
  expect(map.outer.some(o => o.kind === 'more' && o.tone === 'busy')).toBe(false);
  const shownQuiet = map.outer.filter(o => o.kind === 'lane' && !o.busy).length;
  const muted = map.outer.find(o => o.kind === 'more' && o.tone === 'quiet');
  expect(muted?.kind === 'more' ? muted.ids.length : 0).toBe(9 - shownQuiet);
});

test('30 busy + 9 quiet at 440: a green +N, no quiet lane placed, and a muted +9', () => {
  const { inner, extra, quiet } = lanes(30, 9, false);
  const map = ringedMapLayout(inner, extra, quiet, 440);
  expect(map.outer.some(o => o.kind === 'more' && o.tone === 'busy')).toBe(true);
  expect(map.outer.filter(o => o.kind === 'lane' && !o.busy)).toEqual([]);
  const muted = map.outer.find(o => o.kind === 'more' && o.tone === 'quiet');
  expect(muted?.kind === 'more' && muted.ids).toEqual(quiet.map(l => l.id));
});
