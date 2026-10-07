// Native-free surface of the overlay's voice answers (the shared voice send leg and the transcript
// import from here). The recording hook and bar are imported by the overlay directly.
export { MAX_BOUND_ITEMS, MIN_SEGMENT_MS, SegmentTracker, type Segment } from './segments';
export {
  VOICE_ANSWERS_VERSION,
  buildVoiceAnswersMeta,
  installVoiceAnswersCarrier,
  isVoiceAnswersCarrierInstalled,
  parseVoiceAnswersStatus,
  registerVoiceAnswersBinding,
  releaseVoiceAnswersBinding,
  voiceAnswersItemCount,
  type VoiceAnswersItem,
  type VoiceAnswersMeta,
  type VoiceAnswersStatus,
} from './voiceAnswersBinding';
export { default as VoiceAnswersStatusNote } from './VoiceAnswersStatusNote';
