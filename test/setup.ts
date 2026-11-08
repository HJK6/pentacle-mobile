import 'react-native-gesture-handler/jestSetup';
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

// Feed the chat-core package its hostconfig data source so the moved chat-model
// selectors (getHostOrder/getHostTheme) resolve through mobile's config/local
// exactly as before the move. config/local is `require`d LAZILY inside the
// provider functions (not imported at the top of this setup file) so that each
// suite's per-file `jest.mock('expo-constants', ...)` is in effect by the time
// config/local first reads Expo config — a top-level import here would bind
// config/local to the real expo-constants before any test file's mock applies.
import { setHostConfigProvider } from 'pentacle-chat-core';

setHostConfigProvider({
  getHostOrder: (state) =>
    (require('../src/config/local') as typeof import('../src/config/local')).getHostOrder(state),
  getHostTheme: (host) =>
    (require('../src/config/local') as typeof import('../src/config/local')).getHostTheme(host),
});

afterEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
});

// Mock only the device boundary; recording/delivery state machines remain real.
jest.mock('expo-audio', () => ({
  AudioModule: {
    AudioRecorder: jest.fn().mockImplementation(() => ({
      prepareToRecordAsync: jest.fn().mockResolvedValue(undefined),
      record: jest.fn(), stop: jest.fn().mockResolvedValue(undefined),
      getStatus: jest.fn(() => ({ isRecording: true, durationMillis: 3000, metering: -20 })),
      uri: 'file:///voice-take.m4a',
    })),
    getRecordingPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
    requestRecordingPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
  },
  RecordingPresets: { HIGH_QUALITY: {} },
  setAudioModeAsync: jest.fn().mockResolvedValue(undefined),
}));

// Native share/save remains an explicit user action; unit tests mock only the OS boundary.
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn().mockResolvedValue(true),
  shareAsync: jest.fn().mockResolvedValue(undefined),
}));

// OS boundary only: parser, run conversion, row rendering and callbacks remain real.
// Word selection, handles and Copy require the dedicated native Release journey.
jest.mock('../modules/pentacle-message-text', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return { __esModule: true, default: ({ runs, ...props }: any) => React.createElement(Text, props,
    ...runs.map((run: any, index: number) => React.createElement(Text, { key: index, style: {
      fontFamily: run.fontFamily, color: run.color, fontSize: run.fontSize,
      fontStyle: run.italic ? 'italic' : 'normal', backgroundColor: run.backgroundColor,
      textAlign: run.alignment, lineHeight: run.lineHeight,
    } }, run.text))) };
});

// Documents writes are part of the send boundary. Model the native filesystem,
// so transport tests keep exercising the real durable store and send machinery.
// Dedicated recovery/asset tests may replace this boundary with their own disk.
jest.mock('expo-file-system/legacy', () => {
  const files = new Map<string, Buffer>(), dirs = new Set<string>();
  return {
    ...jest.requireActual('expo-file-system/legacy'),
    documentDirectory: 'file:///documents/', cacheDirectory: 'file:///cache/',
    EncodingType: {Base64:'base64',UTF8:'utf8'},
    getInfoAsync: jest.fn(async (p: string) => ({exists:files.has(p)||dirs.has(p)||dirs.has(p+'/'),size:files.get(p)?.length??0,isDirectory:dirs.has(p)||dirs.has(p+'/')})),
    readDirectoryAsync: jest.fn(async (p: string) => [...new Set([...files.keys(),...dirs].filter(k=>k.startsWith(p)&&k!==p).map(k=>k.slice(p.length).split('/')[0]))]),
    makeDirectoryAsync: jest.fn(async (p: string) => {for(let i=8;i<p.length;i++) if(p[i]==='/') dirs.add(p.slice(0,i+1));dirs.add(p);}),
    readAsStringAsync: jest.fn(async (p: string,opts?:{encoding?:string;position?:number;length?:number}) => {const b=files.get(p);if(!b) throw Error('ENOENT');const start=opts?.position??0;return b.subarray(start,opts?.length===undefined?undefined:start+opts.length).toString(opts?.encoding==='base64'?'base64':'utf8');}),
    writeAsStringAsync: jest.fn(async (p: string,text: string) => {files.set(p,Buffer.from(text));}),
    moveAsync: jest.fn(async ({from,to}:{from:string;to:string}) => {const b=files.get(from);if(!b) throw Error('ENOENT');files.set(to,b);files.delete(from);}),
    copyAsync: jest.fn(async ({from,to}:{from:string;to:string}) => {const b=files.get(from);if(!b) throw Error('ENOENT');files.set(to,Buffer.from(b));}),
    deleteAsync: jest.fn(async (p:string) => {const prefix=p.endsWith('/')?p:p+'/';for(const k of files.keys()) if(k===p||k.startsWith(prefix))files.delete(k);for(const k of dirs)if(k===p||k.startsWith(prefix))dirs.delete(k);}),
    getFreeDiskStorageAsync: jest.fn(async()=>1024*1024*1024),
  };
});
