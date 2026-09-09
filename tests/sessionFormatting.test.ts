import { parseTextBlocks } from '../app/pentacle/session/[streamId]';
jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));

jest.mock('expo-router', () => require('./helpers/mocks/expoRouter').makeMock());
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }) }));
jest.mock('expo-secure-store', () => ({
  deleteItemAsync: jest.fn(),
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn(),
}));

test('parseTextBlocks keeps fenced code as code blocks instead of paragraphs', () => {
  const blocks = parseTextBlocks([
    'Here is the patch:',
    '',
    '```ts',
    'const provider = "claude";',
    'console.log(provider);',
    '```',
    '',
    '- render command output',
    '- preserve code fences',
  ].join('\n'));

  expect(blocks).toEqual([
    { type: 'paragraph', text: 'Here is the patch:' },
    { type: 'code', language: 'ts', text: 'const provider = "claude";\nconsole.log(provider);' },
    {
      type: 'list',
      items: [
        { marker: '-', content: 'render command output', ordered: false },
        { marker: '-', content: 'preserve code fences', ordered: false },
      ],
    },
  ]);
});
