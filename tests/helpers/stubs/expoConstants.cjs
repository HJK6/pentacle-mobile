const defaultConfig = {
  extra: {
    wsUrl: 'ws://10.0.0.0:7791',
    hosts: {
      'hosta': {
        label: 'Host A',
        color: '#ff7ab8',
        accent: '#ff7ab8',
        surface: '#21101b',
        border: '#8f3d68',
        header: '#341225',
      },
      'hostb': {
        label: 'Host B',
        color: '#4da3ff',
        accent: '#4da3ff',
        surface: '#0c1827',
        border: '#2f6ca5',
        header: '#102a4a',
      },
      'hostc': {
        label: 'Host C',
        color: '#ff4d5e',
        accent: '#ff4d5e',
        surface: '#211014',
        border: '#a83242',
        header: '#3a1218',
      },
    },
    hostOrder: ['hosta', 'hostb', 'hostc'],
    eas: {
      projectId: 'public-test',
    },
  },
};

const constants = {};
Object.defineProperty(constants, 'expoConfig', {
  enumerable: true,
  get() {
    return globalThis.__PENTACLE_EXPO_CONFIG__ || defaultConfig;
  },
});

module.exports = {
  __esModule: true,
  default: constants,
};
