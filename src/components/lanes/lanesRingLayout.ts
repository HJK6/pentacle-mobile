export type MapPoint = { x: number; y: number };
export type MapLink = { from: MapPoint; to: MapPoint };
/** Left, top, right, bottom. */
export type MapBox = [number, number, number, number];
export const MAP_HEIGHT = 404;
const CENTRE_Y = 190;

const links = (cx: number, cy: number, points: MapPoint[], hub: number, size: number): MapLink[] => points.map(point => {
  const d = Math.hypot(point.x - cx, point.y - cy), ux = (point.x - cx) / d, uy = (point.y - cy) / d;
  return { from: { x: cx + ux * hub / 2, y: cy + uy * hub / 2 }, to: { x: point.x - ux * size / 2, y: point.y - uy * size / 2 } };
});
const around = (count: number, radius: number, cx: number, cy: number) => Array.from({ length: count }, (_, i): MapPoint => {
  const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
  return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
});

/**
 * The approved single-ring map: up to six busy lanes and nothing else, 52 point rings on a 108 point circle.
 * The hub is the size of an inner ring; links run edge to edge.
 */
export function mapLayout(innerCount: number, width: number) {
  const radius = 108, size = 52, hub = size, cx = width / 2, cy = CENTRE_Y;
  const inner = around(innerCount, radius, cx, cy);
  return { cx, cy, radius, size, hub, height: MAP_HEIGHT, inner, links: links(cx, cy, inner, hub, size) };
}

export type MapName = { id: string; title: string };
export type OuterNode =
  | { kind: 'lane'; id: string; busy: boolean; x: number; y: number; box: MapBox }
  | { kind: 'more'; tone: 'busy' | 'quiet'; ids: string[]; x: number; y: number; box: MapBox };

/* Name boxes are estimated before drawing, with the constants of the approved mock (revision 9a8affba, nodeBox and ringBox). */
export const INNER = { size: 46, cw: 6.6, max: 98, lh: 14, gap: 4, mono: 12 };
export const OUTER = { size: 40, cw: 6, max: 78, per: 12, lh: 13, gap: 3, lines: 2 };
/** A name wraps at spaces; a word longer than a line keeps its own line. */
export function wrapName(title: string, per: number): string[] {
  return title.split(' ').reduce((lines, word) => {
    const last = lines[lines.length - 1];
    if (last && `${last} ${word}`.length > per) lines.push(word); else lines[lines.length - 1] = last ? `${last} ${word}` : word;
    return lines;
  }, ['']);
}
/** An inner lane's ring, wrapped name and age line, centred on the ring. The box is the full name width when it may still fit on one line. */
export function innerBox(x: number, y: number, title: string): MapBox {
  const s = INNER, lines = wrapName(title, Math.floor((s.max - 10) / s.cw));
  const w = Math.min(s.max, 12 + s.cw * (title.length * 5.6 > s.max - 10 ? Math.max(...lines.map(l => l.length)) : title.length));
  const half = Math.max(w, s.size) / 2;
  return [x - half, y - s.size / 2, x + half, y + s.size / 2 + s.gap + lines.length * s.lh + s.mono];
}
/** An outer lane's ring with at most two lines of name under it; a +N is the ring alone. */
export function outerBox(x: number, y: number, title?: string): MapBox {
  const s = OUTER, r = s.size / 2;
  if (title === undefined) return [x - r, y - r, x + r, y + r];
  const lines = wrapName(title, s.per).slice(0, s.lines);
  const half = Math.max(r, Math.min(s.max, 10 + s.cw * (title.length * 5 > s.max - 8 ? Math.max(...lines.map(l => l.length)) : title.length)) / 2);
  return [x - half, y - r, x + half, y + r + s.gap + lines.length * s.lh];
}
const MAX_PLACES = 18, MAX_RING = 20;
/* The mock steps the radius by 2 and the start angle by 2 degrees. Even with the caches below that search takes about 0.1 s in the
   phone's JS engine for 30 busy and 40 quiet lanes, so the steps are coarser, as the spec allows: radius by 4, start angle by half
   a place (about 8 ms in the simulator). On a 440 point phone this rarely shows one lane fewer than the mock. */
const RADIUS_STEP = 4, TURNS = 2;

/**
 * The two-circle map. Inner lanes sit on a ring of 46 point rings round the hub; every other lane goes on one outer circle
 * with the hub as its centre, as many as fit with their names, and the rest fold into +N. Coordinates are absolute in a map
 * exactly `width` wide. Ported from `mapPlan` of the approved mock, with coarser search steps.
 *
 * The circle has K evenly spaced places and uses n of them. Busy outer lanes take the free places nearest 12 and 6 o'clock;
 * quiet lanes then go round from the first place, skipping any place that is taken or where a box would come closer than 5
 * to an inner box, 3 to another outer box or 3 to the screen edge. Search, first success wins: n from min(all, 18) down;
 * K from n to min(n + 4, 20); radius from 150 up by 4 to min(200, width / 2 - 26); start angle 0, then half a place;
 * clockwise, then counter-clockwise. Quiet lanes fold into a muted +N; busy lanes fold only when they alone
 * fill the circle, into a green +N, with the muted +N for every quiet lane beside it.
 */
export function ringedMapLayout(innerLanes: MapName[], extra: MapName[], quiet: MapName[], width: number) {
  const s = INNER, count = innerLanes.length, radius = count <= 4 ? 94 : count === 5 ? 96 : 98;
  // Relative to the hub until the height is known.
  const rel = around(count, radius, 0, 0), boxes = rel.map((p, i) => innerBox(p.x, p.y, innerLanes[i].title));
  const top = Math.min(-s.size / 2, ...boxes.map(b => b[1])), bottom = Math.max(s.size / 2, ...boxes.map(b => b[3]));
  const edge = width / 2 - 3;

  // Each box is fixed relative to its ring centre, so it is measured once: half width and depth under the centre.
  // The search below runs thousands of tries, so it works on flat number arrays and allocates nothing per try.
  const r0 = OUTER.size / 2, E = extra.length, Q = quiet.length, BUSY_CHIP = E + Q, QUIET_CHIP = E + Q + 1;
  const half = new Float64Array(E + Q + 2), below = new Float64Array(E + Q + 2);
  [...extra, ...quiet, undefined, undefined].forEach((l, i) => { const b = outerBox(0, 0, l?.title); half[i] = b[2]; below[i] = b[3]; });
  const fixed = Float64Array.from(boxes.flat()), px = new Float64Array(MAX_RING), py = new Float64Array(MAX_RING);
  const at = new Int32Array(MAX_RING);
  // Two outer boxes can only touch when their centres are closer than the largest box allows; places further round the ring
  // than `reach` never do, so a check looks only at the nearby places.
  const span = Math.hypot(2 * Math.max(...half) + 3, Math.max(...below) + r0 + 3);
  let ring = 0, reach = 0;
  /** Item at place i: inside the edge, clear of inner boxes by 5 and of placed outer boxes by 3. */
  const put = (item: number, i: number) => {
    const x = px[i], y = py[i], l = x - half[item], r = x + half[item], t = y - r0, b = y + below[item];
    if (l < -edge || r > edge) return false;
    for (let f = 0; f < fixed.length; f += 4) if (l < fixed[f + 2] + 5 && fixed[f] < r + 5 && t < fixed[f + 3] + 5 && fixed[f + 1] < b + 5) return false;
    for (let d = -reach; d <= reach; d++) {
      const j = (i + d + ring) % ring, q = at[j];
      if (!d || q < 0) continue;
      const qx = px[j], qy = py[j];
      if (l < qx + half[q] + 3 && qx - half[q] < r + 3 && t < qy + below[q] + 3 && qy - r0 < b + 3) return false;
    }
    at[i] = item;
    return true;
  };
  type Try = { busyShown: number; quietShown: number };
  // On one ring, where the busy lanes go does not depend on n, and neither do the places of the first quiet lanes while every
  // busy lane is shown: each lane takes the first free place that fits given the lanes before it. So both are found once per
  // ring, for as many lanes as fit, and each n that tries the same ring reuses them.
  const busyCache = new Map<number, number[]>(), quietCache = new Map<number, number[]>();
  const units = new Map<number, { sin: Float64Array; cos: Float64Array; order: number[] }>();
  const occupy = (seats: number[], upto: number, first: number) => { for (let e = 0; e < upto; e++) at[seats[e]] = first + e; };
  /** One try: n lanes and +N on `places` evenly spaced places at radius ro, starting at turn, going round in dir. */
  const busyFor = (n: number) => E + Q <= n || E <= n - 1 ? E : n - 1 - (Q > 0 ? 1 : 0);
  const seat = (n: number, places: number, ro: number, turn: number, dir: number, key: number, turnKey: number): Try | null => {
    const all = E + Q <= n, quietChip = !all && Q > 0, busyShown = busyFor(n);
    if (busyShown < 0) return null;
    const busyChip = busyShown < E, quietShown = all ? Q : busyChip ? 0 : n - 1 - E;
    let busySeats = busyCache.get(key), quietSeats = quietCache.get(key);
    if ((busySeats && busySeats.length < busyShown) || (quietSeats && quietSeats.length < quietShown)) return null;
    ring = places; reach = 1;
    while (reach < places / 2 && 2 * ro * Math.sin(Math.PI * reach / places) < span) reach++;
    reach = Math.min(reach, Math.floor(places / 2));
    // Directions and the nearest-to-12-and-6 order depend only on the places, not the radius, so each set is worked out once.
    let unit = units.get(turnKey);
    if (!unit) {
      const sin = new Float64Array(places), cos = new Float64Array(places), lean = new Float64Array(places), order = Array.from({ length: places }, (_, i) => i);
      for (let i = 0; i < places; i++) {
        const a = (720 + dir * (turn + i * 360 / places)) % 360, t = a * Math.PI / 180;
        sin[i] = Math.sin(t); cos[i] = Math.cos(t); lean[i] = Math.min(a, Math.abs(180 - a), 360 - a);
      }
      // Stable: equally near places keep their order round the circle.
      order.sort((a, b) => lean[a] - lean[b] || a - b);
      units.set(turnKey, unit = { sin, cos, order });
    }
    for (let i = 0; i < places; i++) { px[i] = ro * unit.sin[i]; py[i] = -ro * unit.cos[i]; at[i] = -1; }
    if (E && !busySeats) {
      // Busy lanes take the free places nearest 12 and 6 o'clock first.
      const order = unit.order;
      busySeats = [];
      // No n that tries this ring shows more busy lanes than the largest n it serves.
      for (let e = 0, most = busyFor(Math.min(places, MAX_PLACES, E + Q)); e < most; e++) {
        let ok = false;
        for (let k = 0; k < places && !ok; k++) if (at[order[k]] < 0 && put(e, order[k])) { ok = true; busySeats.push(order[k]); }
        if (!ok) break;
      }
      busyCache.set(key, busySeats);
      for (let i = 0; i < places; i++) at[i] = -1;
      if (busySeats.length < busyShown) return null;
    }
    occupy(busySeats ?? [], busyShown, 0);
    let i = 0;
    if (quietShown) {
      // Here every busy lane is shown. Quiet lanes go round in order from the first place.
      if (!quietSeats) {
        quietSeats = [];
        for (let j = 0, p = 0; j < Q; j++, p++) {
          while (p < places && (at[p] >= 0 || !put(E + j, p))) p++;
          if (p >= places) break;
          quietSeats.push(p);
        }
        quietCache.set(key, quietSeats);
        for (const p of quietSeats) at[p] = -1;
        if (quietSeats.length < quietShown) return null;
      }
      occupy(quietSeats, quietShown, E);
      i = quietSeats[quietShown - 1] + 1;
    }
    // +N goes on the next free places that fit.
    const chips = (busyChip ? [BUSY_CHIP] : []).concat(quietChip ? [QUIET_CHIP] : []);
    for (const item of chips) {
      while (i < places && (at[i] >= 0 || !put(item, i))) i++;
      if (i++ >= places) return null;
    }
    return { busyShown, quietShown };
  };

  const rmax = Math.min(200, width / 2 - r0 - 6);
  let found: Try | null = null, outerRadius = 0;
  for (let n = Math.min(E + Q, MAX_PLACES); n > 0 && !found; n--)
    for (let places = n; places <= Math.min(MAX_RING, n + 4) && !found; places++)
      for (let k = 0, r = Math.min(150, rmax); r <= rmax && !found; k++, r = Math.min(150, rmax) + k * RADIUS_STEP)
        for (let t = 0; t < TURNS && !found; t++)
          for (let d = 0; d < 2 && !found; d++) {
            const turnKey = (places * TURNS + t) * 2 + d;
            found = seat(n, places, r, t * 360 / places / TURNS, d ? -1 : 1, turnKey * 64 + k, turnKey);
            outerRadius = r;
          }
  const seats: { item: number; x: number; y: number; box: MapBox }[] = [];
  if (found) for (let i = 0; i < ring; i++) if (at[i] >= 0) {
    const item = at[i], x = px[i], y = py[i];
    seats.push({ item, x, y, box: [x - half[item], y - r0, x + half[item], y + below[item]] });
  }
  const t2 = Math.min(top, ...seats.map(p => p.box[1])), b2 = Math.max(bottom, ...seats.map(p => p.box[3]));
  const cx = width / 2, cy = 18 - t2, height = 36 - t2 + b2;
  const shift = (b: MapBox): MapBox => [b[0] + cx, b[1] + cy, b[2] + cx, b[3] + cy];
  const inner = rel.map(p => ({ x: cx + p.x, y: cy + p.y }));
  const outer = seats.map((p): OuterNode => {
    const x = cx + p.x, y = cy + p.y, box = shift(p.box);
    if (p.item === BUSY_CHIP) return { kind: 'more', tone: 'busy', ids: extra.slice(found!.busyShown).map(l => l.id), x, y, box };
    if (p.item === QUIET_CHIP) return { kind: 'more', tone: 'quiet', ids: quiet.slice(found!.quietShown).map(l => l.id), x, y, box };
    return p.item < E ? { kind: 'lane', id: extra[p.item].id, busy: true, x, y, box } : { kind: 'lane', id: quiet[p.item - E].id, busy: false, x, y, box };
  });
  return { cx, cy, radius, size: s.size, hub: s.size, height, inner, innerBoxes: boxes.map(shift), links: links(cx, cy, inner, s.size, s.size),
    outer, outerRadius: seats.length ? outerRadius : 0 };
}
