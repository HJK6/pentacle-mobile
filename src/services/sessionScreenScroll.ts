export type ScrollInputs = {
  hasInitialized: boolean;
  isAtBottom: boolean;
  isDragging: boolean;
  transcriptLength: number;
  previousLength: number;
};

export type ScrollPlan =
  | { kind: 'none' }
  | { kind: 'cold-start' }
  | { kind: 'growth' };

export function planScroll(inputs: ScrollInputs): ScrollPlan {
  if (inputs.isDragging || !inputs.isAtBottom) return { kind: 'none' };
  if (!inputs.hasInitialized) return { kind: 'cold-start' };
  if (inputs.transcriptLength > inputs.previousLength) return { kind: 'growth' };
  return { kind: 'none' };
}

export function autoscrollTelemetryReason(inputs: ScrollInputs, plan: ScrollPlan) {
  if (plan.kind !== 'none') return plan.kind;
  if (inputs.isDragging) return 'user_dragging';
  if (!inputs.isAtBottom) return 'user_not_at_bottom';
  if (inputs.transcriptLength <= inputs.previousLength) return 'no_transcript_growth';
  return 'suppressed';
}
