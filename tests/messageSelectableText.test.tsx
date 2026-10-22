import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { Dimensions, Linking, Platform } from 'react-native';
import { parseInline, teeTelemetrySink } from 'pentacle-chat-core';
import MessageSelectableText, { MessageTextRow, messageTextRuns } from '../src/components/MessageSelectableText';

jest.mock('../modules/pentacle-message-text', () => ({ __esModule: true, default: 'MessageTextNativeBoundary' }));

const base = { fontFamily: 'Rajdhani_500Medium', fontSize: 14.5, lineHeight: 22, color: '#abcdef' };
const inline = {
  strong: { fontFamily: 'Rajdhani_700Bold' }, em: { fontStyle: 'italic' as const },
  code: { fontFamily: 'JetBrainsMono_400Regular', fontSize: 12, backgroundColor: '#00ff001c' },
  link: { color: '#00ff00', textDecorationLine: 'underline' as const },
};

test('existing parsed tokens retain string order, nested style inheritance and exact explicit hrefs', () => {
  const nodes = parseInline('A 😀 **bold _em_** `x` [label](http://127.0.0.1:17889/f2-link?x=1)');
  const runs = messageTextRuns(nodes, base, inline);
  expect(runs.map(run => run.text).join('')).toBe('A 😀 bold em x label');
  expect(runs.find(run => run.text === 'em')).toMatchObject({ fontFamily: 'Rajdhani_700Bold', italic: true });
  expect(runs.find(run => run.text === 'x')).toMatchObject({ fontFamily: 'JetBrainsMono_400Regular', backgroundColor: '#00ff001c' });
  expect(runs.find(run => run.text === 'label')).toMatchObject({ href: 'http://127.0.0.1:17889/f2-link?x=1', underline: true, color: '#00ff00' });
  expect(messageTextRuns([{ type: 'text', value: 'café silver' }, { type: 'break' }, { type: 'text', value: 'amber' }], base).map(run => run.text).join('')).toBe('café silver\namber');
});

test('one native link event opens its original href exactly once; unknown href is ignored', () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  const view = render(<MessageSelectableText testID="text" nodes={parseInline('[label](http://127.0.0.1:17889/f2-link?x=1)')} style={base} inlineStyles={inline} />);
  fireEvent(view.getByTestId('text'), 'linkPress', { nativeEvent: { href: 'http://127.0.0.1:17889/f2-link?x=1' } });
  expect(open).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledWith('http://127.0.0.1:17889/f2-link?x=1');
  fireEvent(view.getByTestId('text'), 'linkPress', { nativeEvent: { href: 'pentacle://foreign' } });
  expect(open).toHaveBeenCalledTimes(1);
  open.mockRestore();
});

test('content updates replace stale runs, bounded layout stabilizes, selection telemetry contains range only', () => {
  const events: any[] = []; const stop = teeTelemetrySink(payload => events.push(payload));
  try {
    const view = render(<MessageTextRow.Provider value="row-a"><MessageSelectableText testID="text" blockId="body" style={base}>A 😀 silver amber violet</MessageSelectableText></MessageTextRow.Provider>);
    fireEvent(view.getByTestId('text'), 'contentSize', { nativeEvent: { contentIdentity: 'row-a:body', width: 300, height: 44 } });
    expect(view.getByTestId('text').props.style).toEqual(expect.arrayContaining([expect.objectContaining({ height: 44 })]));
    fireEvent(view.getByTestId('text'), 'selectionChange', { nativeEvent: { start: 5, end: 11, length: 6, text: 'DO_NOT_RETAIN' } });
    expect(events[events.length - 1]).toMatchObject({ subsystem: 'chat', data: { row_id: 'row-a', block_id: 'body', start: 5, end: 11, length: 6 } });
    expect(JSON.stringify(events)).not.toContain('DO_NOT_RETAIN');
    expect(JSON.stringify(events)).not.toContain('silver');
    view.rerender(<MessageTextRow.Provider value="row-b"><MessageSelectableText testID="text" blockId="body" style={base}>replacement</MessageSelectableText></MessageTextRow.Provider>);
    expect(view.getByTestId('text').props.runs.map((run: any) => run.text).join('')).toBe('replacement');
    fireEvent(view.getByTestId('text'), 'contentSize', { nativeEvent: { contentIdentity: 'row-a:body', width: 300, height: 200 } });
    expect(view.getByTestId('text').props.style).toEqual(expect.arrayContaining([expect.objectContaining({ height: 22 * Dimensions.get('window').fontScale })]));
    fireEvent(view.getByTestId('text'), 'selectionChange', { nativeEvent: { start: 0, end: 100, length: 100 } });
    expect(events).toHaveLength(1);
  } finally { stop(); }
});

test.each(['android', 'web'])('keeps the existing text renderer on %s', platform => {
  const original = Platform.OS;
  Object.defineProperty(Platform, 'OS', { value: platform, configurable: true });
  try {
    const view = render(<MessageSelectableText style={base}>fallback content</MessageSelectableText>);
    expect(view.getByText('fallback content').props.selectable).toBe(true);
  } finally { Object.defineProperty(Platform, 'OS', { value: original, configurable: true }); }
});
