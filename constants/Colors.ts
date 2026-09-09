export const Colors = {
  primary: '#7ef0ba',
  primaryDark: '#25624d',
  background: '#07110d',
  surface: '#0f1b16',
  surfaceLight: '#13241d',
  text: '#edf7f1',
  textSecondary: '#90aaa0',
  textMuted: '#56766a',
  success: '#69e4a6',
  warning: '#f2c879',
  error: '#ff8b7c',
  border: '#254437',
  inboundBubble: '#1f4f3e',
  outboundBubble: '#13241d',
};

export const SCREEN_PAD = 16;
export const TOP_INSET = 52;

export const Fonts = {
  rajdhani: {
    medium: 'Rajdhani_500Medium',
    semiBold: 'Rajdhani_600SemiBold',
    bold: 'Rajdhani_700Bold',
  },
  jetBrainsMono: {
    regular: 'JetBrainsMono_400Regular',
    medium: 'JetBrainsMono_500Medium',
    bold: 'JetBrainsMono_700Bold',
  },
  cinzel: {
    medium: 'Cinzel_500Medium',
    semiBold: 'Cinzel_600SemiBold',
    bold: 'Cinzel_700Bold',
  },
  report: {
    displayMedium: 'SpaceGrotesk_500Medium',
    displaySemiBold: 'SpaceGrotesk_600SemiBold',
    displayBold: 'SpaceGrotesk_700Bold',
    bodyRegular: 'IBMPlexSans_400Regular',
    bodyMedium: 'IBMPlexSans_500Medium',
    bodyBold: 'IBMPlexSans_700Bold',
  },
} as const;

export const FONT_FAMILIES = Fonts;

export type MachineSigilKind = 'djinni' | 'sun' | 'mage' | 'flower';
export type MachineName = 'hosta' | 'hostb' | 'hostc' | 'hostd';
export type ProviderName = 'claude' | 'codex' | 'CLAUDE' | 'CODEX';
export type WorkStatus = 'unresponsive' | 'working' | 'sending' | 'idle' | 'UNRESPONSIVE' | 'WORKING' | 'SENDING' | 'IDLE';
export type Severity = 'info' | 'warning' | 'critical' | 'INFO' | 'WARNING' | 'CRITICAL';

export const MACHINES = {
  'hosta': { kind: 'djinni', accent: '#3dff66', epithet: 'the djinni' },
  'hostb': { kind: 'sun', accent: '#ff2e3e', epithet: 'the flame' },
  'hostc': { kind: 'mage', accent: '#29d4ff', epithet: 'the mage' },
  'hostd': { kind: 'flower', accent: '#b14dff', epithet: 'the bloom' },
} as const satisfies Record<MachineName, { kind: MachineSigilKind; accent: string; epithet: string }>;

export const MACHINE_ORDER = ['hosta', 'hostb', 'hostc', 'hostd'] as const;

export const STATUS = {
  unresponsive: '#ff8b7c',
  working: '#3dff66',
  sending: '#3dff66',
  idle: '#ffb53d',
  UNRESPONSIVE: '#ff8b7c',
  WORKING: '#3dff66',
  SENDING: '#3dff66',
  IDLE: '#ffb53d',
} as const satisfies Record<WorkStatus, string>;

export const SEV = {
  info: '#3dff66',
  warning: '#ffb53d',
  critical: '#ff2e3e',
  INFO: '#3dff66',
  WARNING: '#ffb53d',
  CRITICAL: '#ff2e3e',
} as const satisfies Record<Severity, string>;

export const TypeScale = {
  title: 19,
  sectionTitle: 16,
  body: 14.5,
  compactBody: 13.5,
  preview: 12.5,
  meta: 10.5,
  label: 10,
  tiny: 9,
} as const;

export const Spacing = {
  screenPad: SCREEN_PAD,
  topInset: TOP_INSET,
  cardGap: 12,
  cardPadX: 14,
  cardPadY: 13,
  bevelCard: 12,
  bevelBubble: 10,
} as const;

export const Tokens = {
  palette: {
    ink: '#080b0a',
    panel: '#0d1411',
    text: '#e6fff2',
    dim: '#9dc4b3',
    muted: '#7fa896',
    line: 'rgba(120,255,160,0.16)',
    green: '#3dff66',
    amber: '#ffb53d',
    red: '#ff2e3e',
    star: '#bdffe0',
    codePanel: '#04100a',
    backdrop: 'rgba(3,7,5,0.8)',
  },
  fonts: Fonts,
  type: TypeScale,
  spacing: Spacing,
  machines: MACHINES,
  status: STATUS,
  severity: SEV,
} as const;

export type Tokens = typeof Tokens;
export type Theme = typeof Tokens;

export default {
  light: {
    text: '#000',
    background: '#fff',
    tint: Colors.primary,
    tabIconDefault: '#ccc',
    tabIconSelected: Colors.primary,
  },
  dark: {
    text: Colors.text,
    background: Colors.background,
    tint: Colors.primary,
    tabIconDefault: Colors.textMuted,
    tabIconSelected: Colors.primary,
  },
};
