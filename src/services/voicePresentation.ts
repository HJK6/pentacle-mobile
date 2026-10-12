import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Keyboard, type KeyboardEvent } from 'react-native';
import { voiceRecorder, voiceLifecycleSnapshot, subscribeVoiceLifecycle, sendVoiceTake } from './voiceRecordingEngine';
import type { RecordingSnapshot } from './voiceRecording';
import { useVoiceDelivery, voiceDelivery } from './voiceDelivery';
import { voiceTakeStore } from './voiceTakeStore';
import { ASSISTANT_STREAM_ID, selectAssistantIdentity } from './assistantIdentity';
import { getPentacleStreamState, subscribeVoiceTransport, voiceTransportSnapshot, voiceOriginStatus } from './pentacleStream';
import { setVoiceContextPage } from './voiceContext';

export type VoiceSurfacePage = { page_id: string; title: string; entity_id?: string; question_id?: string };
export type VoiceSurfaceOptions = { chat?: boolean; priority?: number; bottom?: number; top?: number };
type Surface = VoiceSurfaceOptions & { id: string; page: VoiceSurfacePage; sequence: number };
type Host = { id: string; priority: number; sequence: number; name: string };
export type VoicePresentationReceipt = { recordingId: string; streamId: string; originLabel: string; landedAt: number };
export type VoiceKeyboardFrame = { screenY: number; height: number };
type ChatStart = { action: () => void | Promise<void>; disabled: boolean };
const surfaces = new Map<string, Surface>();
const hosts = new Map<string, Host>();
const chatStarts = new Map<string, ChatStart>();
const listeners = new Set<() => void>();
let sequence = 0;
let receiptTimer: ReturnType<typeof setTimeout> | undefined;
let stopMonitor: (() => void) | undefined;
let receiptScope: string | null = null;
let stopReceiptScope: (() => void) | undefined;
let state: { surface: Surface | null; host: Host | null; recordingId: string | null; dy: number; receipt: VoicePresentationReceipt | null; headerBusy: boolean; keyboardFrame: VoiceKeyboardFrame | null; revision: number } = {
  surface: null, host: null, recordingId: null, dy: 0, receipt: null, headerBusy: false, keyboardFrame: null, revision: 0,
};
export const voicePresentationSnapshot = () => state;
function emit(patch: Partial<typeof state> = {}) {
  state = { ...state, ...patch, revision: state.revision + 1 };
  for (const listener of listeners) listener();
}
function currentScope() { const value = voiceTransportSnapshot?.(); return !value || value.authNeeded || !value.serverIdentity || !value.credentialId ? null : `${value.serverIdentity}\n${value.credentialId}`; }
export function clearVoiceReceipt(recordingId?: string) {
  if (!state.receipt || (recordingId && state.receipt.recordingId !== recordingId)) return;
  if (receiptTimer) clearTimeout(receiptTimer);
  receiptTimer = undefined; receiptScope = null; stopReceiptScope?.(); stopReceiptScope = undefined; emit({ receipt: null });
}
function watchReceiptScope() {
  stopReceiptScope?.(); stopReceiptScope = undefined;
  if (!state.receipt) return;
  if (currentScope() !== receiptScope) { clearVoiceReceipt(); return; }
  stopReceiptScope = subscribeVoiceTransport?.(() => { if (state.receipt && currentScope() !== receiptScope) clearVoiceReceipt(); });
}
function projectKeyboardFrame(frame?: VoiceKeyboardFrame | null) {
  const next = frame && Number.isFinite(frame.screenY) && Number.isFinite(frame.height) && frame.height > 0
    ? { screenY: frame.screenY, height: frame.height } : null;
  if (state.keyboardFrame?.screenY !== next?.screenY || state.keyboardFrame?.height !== next?.height) emit({ keyboardFrame: next });
}
/** screenY describes actual occlusion, unlike keyboard height on an already resized window. */
export function voiceKeyboardBottom(frame: VoiceKeyboardFrame | null, windowHeight: number) {
  if (!frame || !Number.isFinite(frame.screenY) || frame.height <= 0) return 0;
  const overlap = Math.min(windowHeight, Math.max(0, windowHeight - frame.screenY));
  return overlap > 0 ? overlap + 12 : 0;
}
function ensureMonitor() {
  if (stopMonitor) return;
  // The scheduler emits only after matching authoritative landed proof. Take disappearance,
  // optimistic acceptance, auth changes and discard never enter this path.
  const stopLanded = voiceDelivery.subscribeLanded?.((receipt: VoicePresentationReceipt) => {
    const capturing = voiceRecorder.snapshot();
    if (capturing && capturing.recordingId !== receipt.recordingId) return;
    const remaining = receipt.landedAt + 2800 - Date.now();
    const incomingScope = currentScope();
    // An inadmissible or delayed proof must not cancel a newer receipt's timer.
    // Validate before touching the currently displayed receipt or its scope.
    if (!Number.isFinite(remaining) || remaining <= 0 || !incomingScope
      || (state.receipt && receipt.landedAt < state.receipt.landedAt)) return;
    if (receiptTimer) clearTimeout(receiptTimer);
    receiptScope = incomingScope;
    emit({ receipt: { ...receipt } }); watchReceiptScope();
    receiptTimer = setTimeout(() => clearVoiceReceipt(receipt.recordingId), remaining);
  });
  const stopCapture = voiceRecorder.subscribe(capture => {
    if (!capture) return;
    if (state.receipt && state.receipt.recordingId !== capture.recordingId) clearVoiceReceipt();
    if (state.recordingId !== capture.recordingId) emit({ recordingId: capture.recordingId, dy: 0 });
  });
  watchReceiptScope();
  // The process presentation owner observes keyboard frames across route/modal handoffs.
  // Anchored chat ignores this projection and retains its existing composer measurements.
  projectKeyboardFrame(Keyboard.metrics?.());
  const keyboardChanged = (event: KeyboardEvent) => projectKeyboardFrame(event.endCoordinates);
  const keyboardSubscriptions = [
    ...(['keyboardWillShow', 'keyboardDidShow', 'keyboardWillChangeFrame', 'keyboardDidChangeFrame'] as const)
      .map(event => Keyboard.addListener(event, keyboardChanged)),
    ...(['keyboardWillHide', 'keyboardDidHide'] as const).map(event => Keyboard.addListener(event, () => projectKeyboardFrame(null))),
  ];
  stopMonitor = () => {
    stopLanded?.(); stopReceiptScope?.(); stopReceiptScope = undefined; stopCapture();
    keyboardSubscriptions.forEach(subscription => subscription.remove()); stopMonitor = undefined;
  };
}
export function subscribeVoicePresentation(listener: () => void) {
  listeners.add(listener); ensureMonitor();
  return () => { listeners.delete(listener); if (!listeners.size) stopMonitor?.(); };
}
export const useVoicePresentationState = () => useSyncExternalStore(subscribeVoicePresentation, voicePresentationSnapshot, voicePresentationSnapshot);
function projectSurfaces() {
  const surface = [...surfaces.values()].sort((a,b) => (b.priority ?? 0) - (a.priority ?? 0) || b.sequence - a.sequence)[0] ?? null;
  const host = [...hosts.values()].sort((a,b) => b.priority - a.priority || b.sequence - a.sequence)[0] ?? null;
  emit({ surface, host });
  if (surface) setVoiceContextPage(surface.page);
}
/** Visibility is explicit: mounted background tabs and covered pages are not visits. */
export function useVoiceSurface(page: VoiceSurfacePage, active = true, options: VoiceSurfaceOptions = {}) {
  const id = useId();
  const { page_id, title, entity_id, question_id } = page;
  const { chat = false, priority = 0, bottom, top } = options;
  const latest = useRef({ page: { page_id, title, ...(entity_id ? { entity_id } : {}), ...(question_id ? { question_id } : {}) }, chat, priority, bottom, top });
  latest.current = { page: { page_id, title, ...(entity_id ? { entity_id } : {}), ...(question_id ? { question_id } : {}) }, chat, priority, bottom, top };
  useLayoutEffect(() => {
    if (!active) return;
    surfaces.set(id, { id, ...latest.current, sequence: ++sequence }); projectSurfaces();
    return () => { surfaces.delete(id); projectSurfaces(); };
  }, [id, active]);
  useLayoutEffect(() => {
    const current = surfaces.get(id); if (!active || !current) return;
    // Updates never unregister the selected page and briefly reveal a covered page.
    surfaces.set(id, { ...current, ...latest.current }); projectSurfaces();
  }, [id, active, page_id, title, entity_id, question_id, chat, priority, bottom, top]);
  return id;
}
/** Keep composer draft ownership in its existing component, including the embedded assistant. */
export function useVoiceChatStart(surfaceId: string | undefined, action: () => void | Promise<void>, disabled: boolean) {
  const actionRef = useRef(action); actionRef.current = action;
  useLayoutEffect(() => {
    if (!surfaceId) return;
    chatStarts.set(surfaceId, { action: () => actionRef.current(), disabled }); emit();
    return () => { chatStarts.delete(surfaceId); emit(); };
  }, [surfaceId, disabled]);
}
export function useVoiceOverlayHost(visible: boolean, priority: number, name: string) {
  const id = useId(); const presentation = useVoicePresentationState();
  useLayoutEffect(() => {
    if (!visible) return;
    hosts.set(id, { id, priority, name, sequence: ++sequence }); projectSurfaces();
    return () => { hosts.delete(id); projectSurfaces(); };
  }, [id, visible, priority, name]);
  return { id, selected: presentation.host?.id === id };
}
export function voiceChatOwnsPresentation(value = state) { return !!value.surface?.chat && !(value.host && value.host.priority > (value.surface.priority ?? 0)); }
export function useVoicePresentation() {
  const presentation = useVoicePresentationState();
  const [capture, setCapture] = useState<RecordingSnapshot | null>(() => voiceRecorder.snapshot());
  useEffect(() => voiceRecorder.subscribe(setCapture), []);
  const lifecycle = useSyncExternalStore(subscribeVoiceLifecycle, voiceLifecycleSnapshot, voiceLifecycleSnapshot);
  const delivery = useVoiceDelivery();
  const recording = capture && voiceTakeStore.get(capture.recordingId) && voiceRecorder.isOwnedByCurrentScope(capture.recordingId) ? capture : null;
  const takes = delivery.takes.filter(take => voiceRecorder.isOwnedByCurrentScope(take.recordingId));
  const take = !recording && !presentation.receipt ? takes.find(item => item.recordingId === presentation.recordingId) ?? takes[0] : undefined;
  const visible = lifecycle.foreground && lifecycle.unlocked && !!(recording || take || presentation.receipt);
  return { ...presentation, capture, recording, take, takes, delivery, lifecycle, visible, anchored: voiceChatOwnsPresentation(presentation) };
}
export function useVoiceBarVisible(surfaceId?: string) {
  const value = useVoicePresentation();
  return value.visible && value.anchored && value.surface?.id === surfaceId;
}
export function setVoiceBarDy(recordingId: string, dy: number) {
  if (!Number.isFinite(dy)) return;
  if (state.recordingId !== recordingId) emit({ recordingId, dy });
  else if (state.dy !== dy) emit({ dy });
}
export function clampVoiceDy(dy: number, { base, minBottom, top, height }: { base: number; minBottom: number; top: number; height: number }) {
  const maximum = Math.max(minBottom, height - top - 44);
  return Math.max(minBottom, Math.min(maximum, base + dy)) - base;
}
export function voiceHeaderStartReady() {
  if (state.surface?.chat) return !!chatStarts.get(state.surface.id) && !chatStarts.get(state.surface.id)?.disabled;
  const transport = voiceTransportSnapshot?.();
  if (!transport) return false;
  const origin = transport.origins.find(item => item.stream_id === ASSISTANT_STREAM_ID);
  return transport.ready && !!transport.credentialId && !transport.authNeeded && !!origin?.session_generation && voiceOriginStatus(ASSISTANT_STREAM_ID, origin.session_generation) === 'available';
}
export async function pressVoiceHeader(onPress?: () => void | Promise<void>) {
  if (state.headerBusy) return;
  const capture = voiceRecorder.snapshot();
  if (capture && (!voiceRecorder.isOwnedByCurrentScope(capture.recordingId) || capture.status === 'starting' || capture.status === 'stopping')) return;
  emit({ headerBusy: true });
  try {
    if (capture) { await sendVoiceTake(capture.recordingId); return; }
    if (onPress) { await onPress(); return; }
    if (state.surface?.chat) {
      const owner = chatStarts.get(state.surface.id);
      if (!owner || owner.disabled) return;
      await owner.action(); return;
    }
    // Resolve immutable destination and generation before the OS permission await.
    const transport = voiceTransportSnapshot();
    const origin = transport.origins.find(item => item.stream_id === ASSISTANT_STREAM_ID);
    if (!voiceHeaderStartReady() || !origin?.session_generation) throw new Error('The assistant chat is not ready for recording. Check your connection and sign-in.');
    const identity = selectAssistantIdentity(getPentacleStreamState());
    await voiceRecorder.start(ASSISTANT_STREAM_ID, { originGeneration: origin.session_generation, originLabel: identity.name, textPrefix: '', images: [], operationKind: 'voice_chat' });
  } finally { emit({ headerBusy: false }); }
}
/** Test-only reset; position/receipt are deliberately never persisted. */
export function resetVoicePresentationForTests() {
  stopMonitor?.(); if (receiptTimer) clearTimeout(receiptTimer); receiptTimer = undefined; receiptScope = null;
  surfaces.clear(); hosts.clear(); chatStarts.clear(); sequence = 0;
  emit({ surface: null, host: null, recordingId: null, dy: 0, receipt: null, headerBusy: false, keyboardFrame: null });
}
