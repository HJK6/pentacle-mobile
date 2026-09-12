import Constants from 'expo-constants';
import type { HostTheme } from '../../pentacle.config.example';
import type { PentacleStreamState } from 'pentacle-chat-core';
import { normalizePentacleHost } from 'pentacle-chat-core';
import { MACHINES, MACHINE_ORDER, type MachineName, type MachineSigilKind } from '../../constants/Colors';

// `sigil` is a presentation hint resolved by getHostMachineName, not part of the
// runtime color theme, so it is not required on RuntimeHostTheme.
export type RuntimeHostTheme = Required<Omit<HostTheme, 'sigil'>> & {
  color: string;
};

const FALLBACK_PALETTE = [
  { color: '#4da3ff', surface: '#0c1827', border: '#2f6ca5', header: '#102a4a' },
  { color: '#7ce0aa', surface: '#0d2018', border: '#347553', header: '#143a2b' },
  { color: '#efc77b', surface: '#211a0d', border: '#7d6230', header: '#3a2a12' },
  { color: '#c28bff', surface: '#1c1328', border: '#664392', header: '#2b1942' },
  { color: '#ff8b7c', surface: '#241513', border: '#8c463f', header: '#3a1d1a' },
  { color: '#63d7d4', surface: '#0c1f20', border: '#2f7375', header: '#123b3d' },
];

function extraConfig(): Record<string, unknown> {
  return (Constants.expoConfig?.extra || {}) as Record<string, unknown>;
}

export function getAssistantRole() {
  const features = extraConfig().features;
  if (!features || typeof features !== 'object' || Array.isArray(features)) return '';
  const assistantRole = (features as Record<string, unknown>).assistantRole;
  return typeof assistantRole === 'string' ? assistantRole.trim() : '';
}

function titlecaseHost(id: string) {
  const value = String(id || '').trim();
  if (!value) return 'Unknown';
  return value
    .split(/[-_\s.]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function hashHost(id: string) {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = ((hash << 5) - hash + id.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function configuredHosts(): Record<string, HostTheme> {
  const hosts = extraConfig().hosts;
  return hosts && typeof hosts === 'object' && !Array.isArray(hosts)
    ? hosts as Record<string, HostTheme>
    : {};
}

export function getBackendWsUrl() {
  const value = String(extraConfig().wsUrl || '').trim();
  if (!value) {
    throw new Error('Missing Pentacle backend wsUrl in Expo config. Check pentacle.config.local.ts.');
  }
  return value;
}

export function getConfiguredHostOrder() {
  const order = extraConfig().hostOrder;
  return Array.isArray(order)
    ? order.map((host) => normalizePentacleHost(String(host || ''))).filter(Boolean)
    : [];
}

export function getHostTheme(id: string): RuntimeHostTheme {
  const hostId = normalizePentacleHost(id);
  const theme = configuredHosts()[hostId];
  if (theme) {
    const color = String(theme.color || theme.accent || '').trim() || FALLBACK_PALETTE[0].color;
    return {
      label: String(theme.label || '').trim() || titlecaseHost(hostId),
      color,
      accent: String(theme.accent || color),
      surface: String(theme.surface || FALLBACK_PALETTE[0].surface),
      border: String(theme.border || FALLBACK_PALETTE[0].border),
      header: String(theme.header || FALLBACK_PALETTE[0].header),
    };
  }

  const fallback = FALLBACK_PALETTE[hashHost(hostId) % FALLBACK_PALETTE.length];
  return {
    label: titlecaseHost(hostId),
    color: fallback.color,
    accent: fallback.color,
    surface: fallback.surface,
    border: fallback.border,
    header: fallback.header,
  };
}

export function getHostOrder(state?: Pick<PentacleStreamState, 'hosts' | 'sessions' | 'machineStats'>) {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const push = (value: string) => {
    const host = normalizePentacleHost(value);
    if (!host || seen.has(host)) return;
    seen.add(host);
    ordered.push(host);
  };

  getConfiguredHostOrder().forEach(push);
  if (state) {
    Object.values(state.hosts || {}).forEach((host) => push(host.host));
    state.sessions?.forEach((session) => push(session.host));
    Object.values(state.machineStats || {}).forEach((stats) => push(stats.host || ''));
  }
  return ordered;
}

const SIGIL_TO_MACHINE: Record<MachineSigilKind, MachineName> = (
  Object.keys(MACHINES) as MachineName[]
).reduce((acc, name) => {
  acc[MACHINES[name].kind] = name;
  return acc;
}, {} as Record<MachineSigilKind, MachineName>);

// Resolve a configured host id to the arcane sigil skin it should wear. This is the
// single host→sigil mapping in the app; every call site (chat rows, roster strip,
// session header, settings tabs, summon grid) delegates here.
//   1. explicit `sigil` on the host's config wins;
//   2. else positional over the configured hostOrder (legacy behavior — preserved for
//      configs without sigils, not the intended skin);
//   3. else the first machine.
export function getHostMachineName(host: string): MachineName {
  const hostId = normalizePentacleHost(host);
  const sigil = configuredHosts()[hostId]?.sigil;
  if (sigil && SIGIL_TO_MACHINE[sigil]) {
    return SIGIL_TO_MACHINE[sigil];
  }
  const index = getConfiguredHostOrder().indexOf(hostId);
  if (index >= 0 && index < MACHINE_ORDER.length) {
    return MACHINE_ORDER[index];
  }
  return MACHINE_ORDER[0];
}
