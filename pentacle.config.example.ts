export type HostTheme = {
  label: string;
  color: string;
  accent?: string;
  surface?: string;
  border?: string;
  header?: string;
  // Which arcane sigil skin this host wears in the app (chat rows, roster strip,
  // session header, settings tabs, summon grid). Resolved by getHostMachineName in
  // src/config/local.ts. When omitted the app falls back positionally over hostOrder,
  // which only preserves legacy positions — set sigil explicitly for the intended skin.
  sigil?: 'djinni' | 'sun' | 'mage' | 'flower';
};

export type PentacleConfig = {
  apple: {
    bundleId: string;
    androidPackage: string;
    expoOwner: string;
    easProjectId: string;
  };
  backend: {
    wsUrl: string;
  };
  dashboardHub?: {
    url: string;
  };
  hosts: Record<string, HostTheme>;
  hostOrder?: string[];
  // Optional local opt-in. Omit or leave assistantRole empty in public builds.
  features?: {
    assistantRole?: string;
  };
};

const config: PentacleConfig = {
  apple: {
    bundleId: 'com.example.pentacle',
    androidPackage: 'com.example.pentacle',
    expoOwner: 'your-expo-username',
    easProjectId: '<your-eas-project-id>',
  },
  backend: {
    wsUrl: 'ws://192.0.2.1:7791',
  },
  dashboardHub: {
    url: 'ws://192.0.2.1:7781',
  },
  hosts: {
    laptop: {
      label: 'Laptop',
      color: '#4da3ff',
      sigil: 'mage',
      accent: '#4da3ff',
      surface: '#0c1827',
      border: '#2f6ca5',
      header: '#102a4a',
    },
  },
  hostOrder: ['laptop'],
};

export default config;
