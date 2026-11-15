/** Lane lists for the home map scenarios, kept free of app imports so layout tests and scripts can use them. */
export type MapLaneClass = 'working' | 'moving' | 'paused' | 'parked';
export type MapScenarioLane = { title: string; icon: string; cls: MapLaneClass; hours: number };
/** The real lanes of the approved map mock (revision 9a8affba) in list order, with hours since last activity. */
export const MAP_REAL_LANES: readonly MapScenarioLane[] = ([
  ['Pentacle', 'pentacle', 'paused', 16 / 60], ['Pentacle mobile', 'phone', 'moving', 12 / 60], ['Government contracts', 'columns', 'moving', 13],
  ['Business acquisition', 'briefcase', 'paused', 12], ['Altum CRM and phone', 'headset', 'paused', 48], ['Altum Automations', 'bot', 'paused', 264],
  ['3D printing', 'cube', 'paused', 22], ['Animation', 'film', 'paused', 480], ['J3', 'shield', 'paused', 48], ['Hosts and accounts', 'server', 'paused', 22],
  ['Personal', 'home', 'paused', 72], ['Express Dispo', 'truck', 'parked', 48], ['World Market Intelligence', 'chart', 'parked', 72],
] as const).map(([title, icon, cls, hours]) => ({ title, icon, cls, hours }));
/** The mock's count picker: lanes cycle through the real ones (Extra lane N past them); every seventh busy lane is working. */
export function mapScenario(busy: number, quiet: number): MapScenarioLane[] {
  const lanes = Array.from({ length: busy + quiet }, (_, i): MapScenarioLane => {
    const base = MAP_REAL_LANES[i % MAP_REAL_LANES.length];
    return { ...base, title: i >= MAP_REAL_LANES.length ? `Extra lane ${i + 1}` : base.title, cls: i < busy ? (i % 7 === 0 ? 'working' : 'moving') : 'paused' };
  });
  return [...lanes, ...MAP_REAL_LANES.filter(l => l.cls === 'parked')];
}
