import React from 'react';
import { act, renderHook } from '@testing-library/react-native';
import { useMobileQuestionFlow, type MobileQuestionDraft, type MobileQuestionEntry } from '../../src/components/MobileQuestions';

const entries: MobileQuestionEntry[] = [{ key: 'a', question: { index: 0, prompt: 'Choose?', options: [{ index: 0, label: 'Yes' }] }, source: null }];
const draft: MobileQuestionDraft = { selectedIndices: [0], text: '', note: 'Retain me', customText: '', customOpen: false };

test('default flow owns its drafts and prunes removed keys unchanged', () => {
  const { result, rerender } = renderHook(({ items }: { items: MobileQuestionEntry[] }) => useMobileQuestionFlow(items), { initialProps: { items: entries } });
  act(() => result.current.setDraft('a', draft));
  expect(result.current.draftFor('a')).toEqual(draft);
  expect(result.current.allAnswered).toBe(true);
  rerender({ items: [] });
  expect(result.current.draftFor('a').note).toBe('');
});

test('controlled draft flow reads and updates the owner state', () => {
  const { result } = renderHook(() => {
    const owned = React.useState<Record<string, MobileQuestionDraft>>({ a: draft });
    return { flow: useMobileQuestionFlow(entries, owned), owned };
  });
  expect(result.current.flow.allAnswered).toBe(true);
  act(() => result.current.flow.setDraft('a', { ...draft, note: 'Updated' }));
  expect(result.current.owned[0].a.note).toBe('Updated');
});
