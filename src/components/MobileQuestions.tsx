import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import type {
  PentacleQuestion,
  PentacleQuestionAnswerValue,
  PentacleQuestionItem,
} from 'pentacle-chat-core';

import { Fonts, Tokens } from '../../constants/Colors';
import type { MachineName } from '../../constants/Colors';
import ArcaneRingFrame from './ArcaneRingFrame';
import Starfield from './Starfield';

type ExtendedQuestion = (PentacleQuestion | PentacleQuestionItem) & {
  index?: number;
  id?: string;
  question_id?: string;
  questionId?: string;
  response_mode?: string;
  allow_custom?: boolean;
  free_text?: boolean;
  min?: number;
  max?: number;
  min_select?: number;
  max_select?: number;
  min_selected?: number;
  max_selected?: number;
  minSelections?: number;
  maxSelections?: number;
};

export type MobileQuestionItem = ExtendedQuestion & {
  index: number;
  prompt: string;
  options: PentacleQuestion['options'];
};

export type MobileQuestionEntry<T = unknown> = {
  key: string;
  question: MobileQuestionItem;
  source: T;
  locked?: boolean;
};

export type MobileQuestionDraft = {
  selectedIndices: number[];
  note: string;
  customText: string;
  text: string;
  customOpen: boolean;
};

export type MobileQuestionAnswer = PentacleQuestionAnswerValue & {
  customText?: string;
};

const EMPTY_DRAFT: MobileQuestionDraft = {
  selectedIndices: [],
  note: '',
  customText: '',
  text: '',
  customOpen: false,
};

export function selectableMobileOptions(question: Pick<MobileQuestionItem, 'options'>) {
  return (question.options || []).filter((option) => !option.meta);
}

export function mobileQuestionItems(question: PentacleQuestion): MobileQuestionItem[] {
  const parent = question as ExtendedQuestion;
  const rawItems = question.multi && Array.isArray(question.questions) && question.questions.length > 0
    ? question.questions as ExtendedQuestion[]
    : [{
      ...parent,
      index: 0,
      prompt: question.prompt,
      options: question.options,
    } as ExtendedQuestion];
  const seen = new Set<string>();
  return rawItems.flatMap((raw, position) => {
    const index = Number.isFinite(Number(raw.index)) ? Number(raw.index) : position;
    const identity = String(raw.question_id || raw.questionId || raw.id || index);
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [{
      ...raw,
      index,
      prompt: String(raw.prompt || question.prompt || `Question ${position + 1}`),
      options: raw.options || [],
      multiSelect: raw.multiSelect ?? (rawItems.length === 1 ? parent.multiSelect : undefined),
      response_mode: raw.response_mode ?? parent.response_mode,
      allow_custom: raw.allow_custom === true || parent.allow_custom === true,
      free_text: raw.free_text === true || parent.free_text === true,
    } as MobileQuestionItem];
  });
}

export function mobileQuestionAllowsCustom(question: MobileQuestionItem) {
  return question.allow_custom === true && selectableMobileOptions(question).length > 0;
}

export function mobileQuestionIsFreeText(question: MobileQuestionItem) {
  return question.response_mode === 'free_text'
    || (question.free_text === true && selectableMobileOptions(question).length === 0);
}

function numericConstraint(...values: unknown[]) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) return Math.floor(numeric);
  }
  return undefined;
}

export function mobileQuestionConstraint(question: MobileQuestionItem, draft: MobileQuestionDraft) {
  if (!question.multiSelect || draft.customText.trim()) return null;
  const min = numericConstraint(question.min_select, question.min_selected, question.minSelections, question.min);
  const max = numericConstraint(question.max_select, question.max_selected, question.maxSelections, question.max);
  const count = draft.selectedIndices.length;
  if (min !== undefined && max !== undefined && min === max && count !== min) return `Select ${min} options`;
  if (min !== undefined && count < min) return `Select at least ${min} option${min === 1 ? '' : 's'}`;
  if (max !== undefined && count > max) return `Select at most ${max} option${max === 1 ? '' : 's'}`;
  return null;
}

export function mobileQuestionAnswered(question: MobileQuestionItem, draft: MobileQuestionDraft) {
  if (mobileQuestionIsFreeText(question)) return draft.text.trim().length > 0;
  return draft.selectedIndices.length > 0
    || (mobileQuestionAllowsCustom(question) && draft.customText.trim().length > 0);
}

export function serializeMobileQuestionAnswer(
  question: MobileQuestionItem,
  draft: MobileQuestionDraft,
): MobileQuestionAnswer {
  const note = draft.note.trim();
  const customText = mobileQuestionAllowsCustom(question) ? draft.customText.trim() : '';
  if (mobileQuestionIsFreeText(question)) {
    return {
      text: draft.text,
      ...(note ? { note: draft.note } : {}),
    };
  }
  if (customText) {
    return { customText: draft.customText };
  }
  const selected = [...draft.selectedIndices].sort((a, b) => a - b);
  return {
    ...(selected.length > 0
      ? (question.multiSelect ? { selectedOptionIndices: selected } : { selectedOptionIndex: selected[0] })
      : {}),
    ...(note ? { note: draft.note } : {}),
  };
}

export function useMobileQuestionFlow<T>(entries: readonly MobileQuestionEntry<T>[]) {
  const [drafts, setDrafts] = useState<Record<string, MobileQuestionDraft>>({});
  const identity = entries.map((entry) => entry.key).join('|');

  useEffect(() => {
    const valid = new Set(entries.map((entry) => entry.key));
    setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([key]) => valid.has(key))));
  }, [identity]); // eslint-disable-line react-hooks/exhaustive-deps

  const draftFor = (key: string) => drafts[key] || EMPTY_DRAFT;
  const setDraft = (key: string, next: MobileQuestionDraft) => {
    setDrafts((current) => ({ ...current, [key]: next }));
  };
  const resetDrafts = () => setDrafts({});
  const answered = useMemo(() => new Set(entries
    .filter((entry) => entry.locked || (mobileQuestionAnswered(entry.question, drafts[entry.key] || EMPTY_DRAFT)
      && !mobileQuestionConstraint(entry.question, drafts[entry.key] || EMPTY_DRAFT)))
    .map((entry) => entry.key)), [entries, drafts]);
  const unansweredCount = Math.max(0, entries.length - answered.size);
  return {
    answered,
    unansweredCount,
    allAnswered: entries.length > 0 && unansweredCount === 0,
    draftFor,
    setDraft,
    resetDrafts,
    answerFor: (entry: MobileQuestionEntry<T>) => serializeMobileQuestionAnswer(entry.question, draftFor(entry.key)),
  };
}

export function QuestionFab({ count, accent, onPress }: { count: number; accent: string; onPress: () => void }) {
  if (count <= 0) return null;
  return (
    <View pointerEvents="box-none" style={styles.fabDock}>
      <View style={[styles.fabPulse, { borderColor: `${accent}66` }]} />
      <Pressable
        testID="question-fab"
        accessibilityRole="button"
        accessibilityLabel={`${count} unanswered question${count === 1 ? '' : 's'}`}
        onPress={onPress}
        style={[styles.fab, { backgroundColor: accent, shadowColor: accent }]}
      >
        <Svg width={27} height={27} viewBox="0 0 28 28" accessibilityLabel="Questions">
          <Path d="M9.8 10.5c.5-3.8 8.1-4.4 8.4.3.2 3.3-4.1 3.5-4.1 6.4" fill="none" stroke={Tokens.palette.ink} strokeWidth="2.4" strokeLinecap="round" />
          <Circle cx="14" cy="21" r="1.2" fill={Tokens.palette.ink} />
        </Svg>
        <View testID="question-fab-count" style={[styles.fabBadge, { borderColor: accent }]}>
          <Text style={[styles.fabBadgeText, { color: accent }]}>{count}</Text>
        </View>
      </Pressable>
    </View>
  );
}

function QuestionDots({ entries, activeIndex, answered, accent, onChange, compact = false }: {
  entries: readonly MobileQuestionEntry[];
  activeIndex: number;
  answered: ReadonlySet<string>;
  accent: string;
  onChange: (index: number) => void;
  compact?: boolean;
}) {
  return (
    <View style={styles.dots}>
      {entries.map((entry, index) => (
        <Pressable
          key={entry.key}
          testID={`question-dot-${index}`}
          accessibilityRole="button"
          accessibilityLabel={`Question ${index + 1}`}
          accessibilityState={{ selected: index === activeIndex, checked: answered.has(entry.key) }}
          onPress={() => onChange(index)}
          style={compact ? [
            styles.cardDot,
            {
              borderColor: index === activeIndex || answered.has(entry.key) ? accent : Tokens.palette.muted,
              backgroundColor: answered.has(entry.key) ? accent : (index === activeIndex ? `${accent}44` : 'transparent'),
            },
          ] : [
            styles.dot,
            answered.has(entry.key) && { backgroundColor: `${accent}66` },
            index === activeIndex && { width: 22, backgroundColor: accent },
          ]}
        />
      ))}
    </View>
  );
}

export function MobileQuestionOne({ entry, draft, accent, disabled, onChange, onInputFocus, compact = false, testPrefix = 'question' }: {
  entry: MobileQuestionEntry;
  draft: MobileQuestionDraft;
  accent: string;
  disabled?: boolean;
  onChange: (draft: MobileQuestionDraft) => void;
  onInputFocus?: (target: number, alignEnd?: boolean) => void;
  compact?: boolean;
  testPrefix?: string;
}) {
  const { question } = entry;
  const options = selectableMobileOptions(question);
  const freeText = mobileQuestionIsFreeText(question);
  const allowCustom = mobileQuestionAllowsCustom(question);
  const constraint = mobileQuestionConstraint(question, draft);
  const noteOptionIndex = draft.selectedIndices[draft.selectedIndices.length - 1];
  const selectedPreview = options
    .filter((option) => draft.selectedIndices.includes(option.index))
    .map((option) => (typeof (option as typeof option & { preview?: unknown }).preview === 'string'
      ? String((option as typeof option & { preview?: string }).preview).trim()
      : ''))
    .find(Boolean) || '';
  const select = (index: number) => {
    const selected = draft.selectedIndices.includes(index);
    const selectedIndices = question.multiSelect
      ? (selected ? draft.selectedIndices.filter((value) => value !== index) : [...draft.selectedIndices, index])
      : [index];
    onChange({ ...draft, selectedIndices, customOpen: false, customText: '' });
  };
  return (
    <View testID={testPrefix === 'question' ? `question-card-${question.index}` : `${testPrefix}-one`} style={styles.questionOne}>
      <Text testID={`${testPrefix}-prompt`} style={[styles.prompt, compact && styles.compactPrompt]}>{question.prompt}</Text>
      {options.map((option) => {
        const selected = draft.selectedIndices.includes(option.index);
        return (
          <View
            key={option.index}
            testID={`${testPrefix}-option-container-${option.index}`}
            style={[styles.optionContainer, selected && { borderColor: accent, backgroundColor: `${accent}1e` }]}
          >
            <Pressable
              testID={`${testPrefix}-option-${option.index}`}
              accessibilityRole={question.multiSelect ? 'checkbox' : 'radio'}
              accessibilityState={{ disabled: !!disabled, checked: selected }}
              disabled={disabled}
              onPress={() => select(option.index)}
              style={styles.option}
            >
              <View style={[styles.optionMarker, selected && { borderColor: accent, backgroundColor: accent }]} />
              <View style={styles.optionCopy}>
                <Text style={[styles.optionLabel, !selected && { color: accent }, compact && styles.compactOptionLabel]}>{option.label}</Text>
                {option.description ? (
                  <Text testID={`${testPrefix}-option-description-${option.index}`} style={[styles.optionDescription, compact && styles.compactOptionDescription]}>
                    {option.description}
                  </Text>
                ) : null}
              </View>
            </Pressable>
            {selected && !draft.customOpen && option.index === noteOptionIndex ? (
              <View testID={`${testPrefix}-selected-note-${option.index}`} style={styles.optionNoteRow}>
                <Text style={[styles.noteGlyph, { color: accent }]}>⌁</Text>
                <TextInput
                  testID={testPrefix === 'question' ? `question-note-${question.index}` : `${testPrefix}-note`}
                  value={draft.note}
                  onChangeText={(note) => onChange({ ...draft, note })}
                  onFocus={(event) => onInputFocus?.(event.nativeEvent.target)}
                  placeholder="Notes…"
                  placeholderTextColor={Tokens.palette.muted}
                  editable={!disabled}
                  multiline
                  numberOfLines={2}
                  style={[styles.textarea, { borderColor: `${accent}66` }]}
                />
              </View>
            ) : null}
          </View>
        );
      })}
      {selectedPreview ? (
        <ScrollView testID={`question-option-preview-${question.index}`} horizontal>
          <Text testID={`question-option-preview-text-${question.index}`} style={styles.optionDescription}>{selectedPreview}</Text>
        </ScrollView>
      ) : null}
      {allowCustom ? (
        <View testID={`${testPrefix}-custom-container`} style={[styles.optionContainer, draft.customOpen && { borderColor: accent, backgroundColor: `${accent}1e` }]}>
          <Pressable
            testID={`${testPrefix}-custom-toggle`}
            accessibilityRole={question.multiSelect ? 'checkbox' : 'radio'}
            accessibilityState={{ disabled: !!disabled, checked: draft.customOpen, expanded: draft.customOpen }}
            disabled={disabled}
            onPress={() => onChange({
              ...draft,
              selectedIndices: draft.customOpen ? draft.selectedIndices : [],
              customOpen: !draft.customOpen,
              customText: draft.customOpen ? '' : draft.customText,
              note: draft.customOpen ? draft.note : '',
            })}
            style={styles.option}
          >
            <View style={[styles.optionMarker, (draft.customOpen || draft.customText) && { borderColor: accent }]} />
            <Text style={[styles.optionLabel, !draft.customOpen && { color: accent }, compact && styles.compactOptionLabel]}>Custom</Text>
          </Pressable>
          {draft.customOpen ? (
            <TextInput
              testID={`${testPrefix}-custom-answer`}
              value={draft.customText}
              onChangeText={(customText) => onChange({ ...draft, customText })}
              onFocus={(event) => onInputFocus?.(event.nativeEvent.target, true)}
              placeholder="Type your answer…"
              placeholderTextColor={Tokens.palette.muted}
              editable={!disabled}
              multiline
              numberOfLines={3}
              style={[styles.textarea, styles.customTextarea, { borderColor: `${accent}66` }]}
            />
          ) : null}
        </View>
      ) : null}
      {freeText ? (
        <View style={styles.optionContainer}>
          <TextInput
            testID={testPrefix === 'question' ? `question-freetext-${question.index}` : `${testPrefix}-free-text`}
            value={draft.text}
            onChangeText={(text) => onChange({ ...draft, text })}
            placeholder="Type your answer…"
            placeholderTextColor={Tokens.palette.muted}
            editable={!disabled}
            multiline
            onFocus={(event) => onInputFocus?.(event.nativeEvent.target, true)}
            style={[styles.textarea, { borderColor: `${accent}66` }]}
          />
          <View style={styles.optionNoteRow}>
            <Text style={[styles.noteGlyph, { color: accent }]}>⌁</Text>
            <TextInput
              testID={testPrefix === 'question' ? `question-note-${question.index}` : `${testPrefix}-note`}
              value={draft.note}
              onChangeText={(note) => onChange({ ...draft, note })}
              onFocus={(event) => onInputFocus?.(event.nativeEvent.target, true)}
              placeholder="Notes…"
              placeholderTextColor={Tokens.palette.muted}
              editable={!disabled}
              multiline
              numberOfLines={2}
              style={[styles.textarea, { borderColor: `${accent}66` }]}
            />
          </View>
        </View>
      ) : null}
      {constraint ? <Text testID={`${testPrefix}-constraint`} style={styles.warning}>{constraint}</Text> : null}
    </View>
  );
}

export function QuestionOverlay<T>({ entries, activeIndex, flow, accent, machineName, title, submitting, error, onIndexChange, onCancel, onSend }: {
  entries: readonly MobileQuestionEntry<T>[];
  activeIndex: number;
  flow: ReturnType<typeof useMobileQuestionFlow<T>>;
  accent: string;
  machineName?: MachineName;
  title: string;
  submitting?: boolean;
  error?: string | null;
  onIndexChange: (index: number) => void;
  onCancel: () => void;
  onSend: () => void;
}) {
  const entry = entries[Math.min(activeIndex, Math.max(0, entries.length - 1))];
  const scrollRef = useRef<ScrollView>(null);
  const focusedTargetRef = useRef<number | null>(null);
  const focusedAlignEndRef = useRef(false);
  const [keyboardClearance, setKeyboardClearance] = useState(0);
  const scrollToFocusedInput = () => {
    const target = focusedTargetRef.current;
    requestAnimationFrame(() => {
      if (focusedAlignEndRef.current) {
        scrollRef.current?.scrollToEnd({ animated: true });
        return;
      }
      const responder = scrollRef.current?.getScrollResponder?.();
      if (target && responder?.scrollResponderScrollNativeHandleToKeyboard) {
        responder.scrollResponderScrollNativeHandleToKeyboard(target, 72, true);
      } else {
        scrollRef.current?.scrollToEnd({ animated: true });
      }
    });
  };
  useEffect(() => {
    const handleShow = () => {
      setKeyboardClearance(112);
      scrollToFocusedInput();
    };
    const handleHide = () => setKeyboardClearance(0);
    const willShow = Keyboard.addListener('keyboardWillShow', handleShow);
    const didShow = Keyboard.addListener('keyboardDidShow', handleShow);
    const willHide = Keyboard.addListener('keyboardWillHide', handleHide);
    const didHide = Keyboard.addListener('keyboardDidHide', handleHide);
    return () => {
      willShow.remove();
      didShow.remove();
      willHide.remove();
      didHide.remove();
    };
  }, []); // Focus target and scroll ref are intentionally ref-backed.
  useEffect(() => {
    if (keyboardClearance <= 0) return undefined;
    const duringAnimation = setTimeout(scrollToFocusedInput, 120);
    const afterAnimation = setTimeout(scrollToFocusedInput, 420);
    return () => {
      clearTimeout(duringAnimation);
      clearTimeout(afterAnimation);
    };
  }, [keyboardClearance]); // Re-scroll after the keyboard clearance has affected layout.
  if (!entry) return null;
  const last = activeIndex === entries.length - 1;
  const revealFocusedInput = (target: number, alignEnd = false) => {
    focusedTargetRef.current = target;
    focusedAlignEndRef.current = alignEnd;
    scrollToFocusedInput();
  };
  return (
    <View testID="question-overlay" accessibilityViewIsModal style={styles.overlay}>
      <Starfield />
      <View style={[styles.overlayHeader, { borderBottomColor: `${accent}33` }]}>
        <ArcaneRingFrame machine={machineName} color={accent} size={32} sigilSize={18} />
        <View style={styles.headerCopy}>
          <Text testID="question-page-label" style={[styles.counter, { color: accent }]}>QUESTION {activeIndex + 1} / {entries.length}</Text>
          <Text numberOfLines={1} style={styles.chatTitle}>{title}</Text>
        </View>
        <Pressable testID="question-overlay-cancel" accessibilityRole="button" accessibilityLabel="Close questions" onPress={onCancel} style={styles.closeButton}>
          <Text style={styles.closeText}>×</Text>
        </Pressable>
      </View>
      <KeyboardAvoidingView testID="question-keyboard-avoiding" style={styles.overlayBody} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={0}>
        <ScrollView testID="question-overlay-scroll" ref={scrollRef} key={entry.key} contentContainerStyle={[styles.overlayBodyContent, keyboardClearance > 0 && { paddingBottom: keyboardClearance }]} keyboardShouldPersistTaps="handled">
          <MobileQuestionOne
            entry={entry}
            draft={flow.draftFor(entry.key)}
            accent={accent}
            disabled={entry.locked || submitting}
            onChange={(draft) => flow.setDraft(entry.key, draft)}
            onInputFocus={revealFocusedInput}
          />
          {error ? <Text testID="question-submit-error" style={styles.warning}>{error}</Text> : null}
        </ScrollView>
      </KeyboardAvoidingView>
      <View style={[styles.footer, { borderTopColor: `${accent}22` }]}>
        <QuestionDots entries={entries} activeIndex={activeIndex} answered={flow.answered} accent={accent} onChange={onIndexChange} />
        <View style={styles.footerActions}>
          <Pressable testID="question-cancel" onPress={onCancel} style={styles.secondaryButton}><Text style={styles.secondaryText}>Cancel</Text></Pressable>
          {activeIndex > 0 ? (
            <Pressable testID="question-page-prev" onPress={() => onIndexChange(activeIndex - 1)} style={styles.secondaryButton}><Text style={styles.secondaryText}>Back</Text></Pressable>
          ) : null}
          {!last ? (
            <Pressable testID="question-page-next" onPress={() => onIndexChange(activeIndex + 1)} style={[styles.primaryButton, { backgroundColor: accent }]}><Text style={styles.primaryText}>Next</Text></Pressable>
          ) : (
            <Pressable
              testID="question-submit"
              accessibilityRole="button"
              accessibilityState={{ disabled: !flow.allAnswered || !!submitting }}
              disabled={!flow.allAnswered || submitting}
              onPress={onSend}
              style={[styles.primaryButton, { backgroundColor: accent }, (!flow.allAnswered || submitting) && styles.disabledPrimary]}
            >
              <Text style={[styles.primaryText, (!flow.allAnswered || submitting) && styles.disabledPrimaryText]}>{submitting ? 'Sending' : (flow.allAnswered ? 'Send answers' : `${flow.unansweredCount} unanswered`)}</Text>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

export function QuestionCardSurface<T>({ entries, activeIndex, flow, accent, submitting, error, onIndexChange, onSend }: {
  entries: readonly MobileQuestionEntry<T>[];
  activeIndex: number;
  flow: ReturnType<typeof useMobileQuestionFlow<T>>;
  accent: string;
  submitting?: boolean;
  error?: string | null;
  onIndexChange: (index: number) => void;
  onSend: () => void;
}) {
  const entry = entries[Math.min(activeIndex, Math.max(0, entries.length - 1))];
  if (!entry) return null;
  const multi = entries.length > 1;
  const isLast = activeIndex >= entries.length - 1;
  const submitDisabled = !flow.allAnswered || !!submitting;
  const currentAnswered = flow.answered.has(entry.key);
  const icon = (kind: 'previous' | 'next' | 'send', color: string) => (
    <Svg width={17} height={17} viewBox="0 0 24 24" fill="none">
      <Path
        d={kind === 'previous' ? 'M15 18l-6-6 6-6' : kind === 'next' ? 'M9 18l6-6-6-6' : 'M5 12l4 4L19 6'}
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
  return (
    <View style={[styles.cardSurface, { borderColor: `${accent}55` }]}>
      <View style={styles.cardTopline}>
        <Text testID="smart-question-counter" style={styles.cardCounter}>{String(activeIndex + 1).padStart(2, '0')}/{String(entries.length).padStart(2, '0')}</Text>
        <QuestionDots entries={entries} activeIndex={activeIndex} answered={flow.answered} accent={accent} onChange={onIndexChange} compact />
      </View>
      <MobileQuestionOne
        entry={entry}
        draft={flow.draftFor(entry.key)}
        accent={accent}
        disabled={entry.locked || submitting}
        onChange={(draft) => flow.setDraft(entry.key, draft)}
        compact
        testPrefix="smart-question"
      />
      {error ? <Text style={styles.warning}>{error}</Text> : null}
      <View style={styles.cardActions}>
        {multi ? (
          <Pressable
            testID="smart-question-previous"
            accessibilityRole="button"
            accessibilityLabel="Previous"
            onPress={() => onIndexChange(Math.max(0, activeIndex - 1))}
            style={[styles.cardIconButton, { borderColor: Tokens.palette.line }]}
          >
            {icon('previous', Tokens.palette.dim)}
          </Pressable>
        ) : null}
        {multi && !isLast ? (
          <Pressable
            testID="smart-question-next"
            accessibilityRole="button"
            accessibilityLabel="Next"
            onPress={() => onIndexChange(activeIndex + 1)}
            style={[styles.cardIconButton, { borderColor: currentAnswered ? accent : Tokens.palette.line, backgroundColor: currentAnswered ? `${accent}1c` : 'transparent' }]}
          >
            {icon('next', currentAnswered ? accent : Tokens.palette.dim)}
          </Pressable>
        ) : (
          <Pressable
            testID="smart-question-submit"
            accessibilityRole="button"
            accessibilityLabel="Submit"
            accessibilityState={{ disabled: submitDisabled }}
            disabled={submitDisabled}
            onPress={onSend}
            style={[styles.cardSubmitButton, { borderColor: submitDisabled ? Tokens.palette.line : accent, backgroundColor: submitDisabled ? 'transparent' : `${accent}28` }, submitDisabled && styles.cardSubmitDisabled]}
          >
            <Text style={[styles.cardActionText, { color: submitDisabled ? Tokens.palette.muted : accent }]}>{submitting ? 'SENDING' : (multi ? 'SEND ALL' : 'SEND')}</Text>
          </Pressable>
        )}
        {multi && !isLast ? (
          <Pressable
            testID="smart-question-submit-all"
            accessibilityRole="button"
            accessibilityLabel="Submit all"
            accessibilityState={{ disabled: submitDisabled }}
            disabled={submitDisabled}
            onPress={onSend}
            style={[styles.cardSubmitAllButton, { borderColor: submitDisabled ? Tokens.palette.line : accent, backgroundColor: submitDisabled ? 'transparent' : `${accent}28` }, submitDisabled && styles.cardIconDisabled]}
          >
            {icon('send', submitDisabled ? Tokens.palette.muted : accent)}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fabDock: { position: 'absolute', right: 18, bottom: 96, width: 66, height: 66, alignItems: 'center', justifyContent: 'center', zIndex: 80 },
  fabPulse: { position: 'absolute', width: 62, height: 62, borderRadius: 31, borderWidth: 1.5, opacity: 0.72 },
  fab: { width: 58, height: 58, borderRadius: 29, alignItems: 'center', justifyContent: 'center', shadowOpacity: 0.8, shadowRadius: 13, shadowOffset: { width: 0, height: 2 }, elevation: 8 },
  fabBadge: { position: 'absolute', right: -3, top: -3, minWidth: 21, height: 21, borderRadius: 11, borderWidth: 1.5, backgroundColor: Tokens.palette.ink, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  fabBadgeText: { fontFamily: Fonts.jetBrainsMono.bold, fontSize: 11 },
  overlay: { ...StyleSheet.absoluteFillObject, zIndex: 200, backgroundColor: Tokens.palette.ink },
  overlayHeader: { paddingTop: 56, paddingHorizontal: 16, paddingBottom: 13, borderBottomWidth: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerCopy: { flex: 1, gap: 2 },
  counter: { color: Tokens.palette.dim, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 11, letterSpacing: 1.5 },
  chatTitle: { color: Tokens.palette.muted, fontFamily: Fonts.rajdhani.medium, fontSize: 13 },
  closeButton: { width: 34, height: 34, borderWidth: 1, borderColor: Tokens.palette.line, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  closeText: { color: Tokens.palette.dim, fontSize: 24, fontWeight: '200' },
  overlayBody: { flex: 1 },
  overlayBodyContent: { paddingVertical: 20, paddingHorizontal: 16 },
  questionOne: { gap: 13 },
  prompt: { color: Tokens.palette.text, fontFamily: Fonts.rajdhani.semiBold, fontSize: 21, lineHeight: 26.5, marginBottom: 2 },
  compactPrompt: { fontSize: 16, lineHeight: 20.2 },
  optionContainer: { borderWidth: 1, borderColor: Tokens.palette.line, borderRadius: 4, overflow: 'hidden' },
  option: { minHeight: 58, paddingHorizontal: 14, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12 },
  optionMarker: { width: 15, height: 15, borderRadius: 8, borderWidth: 1, borderColor: Tokens.palette.muted },
  optionCopy: { flex: 1, gap: 3 },
  optionLabel: { color: Tokens.palette.text, fontFamily: Fonts.rajdhani.semiBold, fontSize: 16 },
  compactOptionLabel: { fontSize: 14.5 },
  optionDescription: { color: Tokens.palette.muted, fontFamily: Fonts.rajdhani.medium, fontSize: 13.5, lineHeight: 19 },
  compactOptionDescription: { fontSize: 12.5, lineHeight: 17.5 },
  optionNoteRow: { paddingHorizontal: 14, paddingBottom: 12, flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  noteGlyph: { fontSize: 15, lineHeight: 22, opacity: 0.7 },
  textarea: { flex: 1, minHeight: 58, borderWidth: 1, borderRadius: 4, color: Tokens.palette.text, backgroundColor: '#04100a', paddingHorizontal: 12, paddingVertical: 10, fontFamily: Fonts.rajdhani.medium, fontSize: 14.5, lineHeight: 21, textAlignVertical: 'top' },
  customTextarea: { marginHorizontal: 14, marginBottom: 12, minHeight: 78 },
  warning: { color: Tokens.palette.amber, fontFamily: Fonts.jetBrainsMono.medium, fontSize: 10, marginTop: 8 },
  footer: { borderTopWidth: 1, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 26, gap: 13, backgroundColor: Tokens.palette.ink },
  dots: { minHeight: 12, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 7 },
  dot: { width: 8, height: 8, borderRadius: 999, borderWidth: 0, backgroundColor: Tokens.palette.line },
  cardDot: { width: 9, height: 9, borderRadius: 5, borderWidth: 1.4 },
  footerActions: { flexDirection: 'row', gap: 10 },
  secondaryButton: { minHeight: 44, minWidth: 76, borderRadius: 4, borderWidth: 1, borderColor: Tokens.palette.line, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  secondaryText: { color: Tokens.palette.muted, fontFamily: Fonts.rajdhani.bold, fontSize: 15.5 },
  primaryButton: { flex: 1, minHeight: 44, borderRadius: 4, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  primaryText: { color: Tokens.palette.ink, fontFamily: Fonts.rajdhani.bold, fontSize: 15.5 },
  disabled: { opacity: 0.35 },
  disabledPrimary: { backgroundColor: 'transparent', borderWidth: 1, borderColor: Tokens.palette.line, opacity: 1 },
  disabledPrimaryText: { color: Tokens.palette.dim },
  cardSurface: { borderWidth: 1, backgroundColor: 'rgba(6,13,9,0.94)', padding: 14, gap: 13 },
  cardTopline: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardCounter: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 10, letterSpacing: 1 },
  cardActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardIconButton: { width: 38, height: 38, flexShrink: 0, borderRadius: 4, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  cardSubmitAllButton: { width: 44, height: 38, flexShrink: 0, borderRadius: 4, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  cardSubmitButton: { flex: 1, height: 38, borderRadius: 4, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  cardActionText: { fontFamily: Fonts.jetBrainsMono.bold, fontSize: 12, letterSpacing: 1 },
  cardIconDisabled: { opacity: 0.5 },
  cardSubmitDisabled: { opacity: 0.55 },
});
