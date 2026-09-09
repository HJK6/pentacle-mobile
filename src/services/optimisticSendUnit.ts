import type { ChatAttachment } from 'pentacle-chat-core';

import { uploadStagedAttachments } from './attachmentUpload';
import type { ProcessedAsset } from './imageCapture';
import type { RenderAttachment } from '../types/renderAttachment';

// Upload+send is ONE optimistic unit with a definite terminal outcome
// (optimistic_send_stuck_after_daemon_restart_2026_09). The upload leg runs
// before any `send` is dispatched, so a rejection here — a transport drop, an
// RPC timeout, or an explicit `upload_blob.error` — can never be "kept
// pending": there is no daemon echo and no socket generation that could ever
// reconcile the row. Its only terminal paths are land or visible-failed +
// Retry, and Retry re-drives the whole unit from the retained staged asset
// (no re-pick, no queue that survives the process). Both composer surfaces
// (`app/pentacle/session/[streamId].tsx`, `app/(tabs)/unified.tsx`) call this
// so the rule cannot drift between them.

export interface StagedUpload {
  // The already-compressed local assets, retained so Retry can re-upload.
  staged: ProcessedAsset[];
  // The in-flight upload (started immediately so it overlaps the row insert).
  promise: Promise<ChatAttachment[]>;
}

export function beginStagedUpload(staged: ProcessedAsset[]): StagedUpload {
  return { staged, promise: uploadStagedAttachments(staged) };
}

// Pair wire attachments with their local thumbs (by index) so the optimistic
// bubble keeps rendering the local file while the daemon blob key travels.
export function withRenderUris(
  attachments?: ChatAttachment[],
  thumbs?: RenderAttachment[],
): ChatAttachment[] | undefined {
  if (!attachments?.length) return undefined;
  return attachments.map((attachment, index) => {
    const thumb = thumbs?.[index];
    return thumb?.uri
      ? { ...attachment, uri: thumb.uri, width: attachment.width ?? thumb.width, height: attachment.height ?? thumb.height }
      : attachment;
  });
}

export interface UploadLegActions {
  replaceOptimisticAttachments: (optimisticId: string, attachments: ChatAttachment[]) => void;
  markOptimisticFailed: (optimisticId: string, reason?: string) => void;
  retainUploadForRetry: (optimisticId: string, reupload: () => Promise<ChatAttachment[]>) => void;
}

/**
 * Settle the upload leg of an optimistic row. Resolves with the wire
 * attachments once the blob upload completes (the row's attachments are swapped
 * to the daemon keys, thumbs kept); on ANY rejection the row is failed visibly
 * (Retry affordance) and the error is rethrown. Callers must not wrap this in
 * the send-leg "keep pending on transport error" swallow.
 */
export async function settleUploadLeg(args: {
  optimisticId: string;
  optimisticAttachments?: ChatAttachment[];
  thumbs?: RenderAttachment[];
  upload?: StagedUpload;
  actions: UploadLegActions;
}): Promise<ChatAttachment[] | undefined> {
  const { optimisticId, optimisticAttachments, thumbs, upload, actions } = args;
  if (!upload) return optimisticAttachments;
  actions.retainUploadForRetry(optimisticId, async () => {
    const wire = await uploadStagedAttachments(upload.staged);
    return withRenderUris(wire, thumbs) ?? wire;
  });
  let wireAttachments: ChatAttachment[];
  try {
    wireAttachments = await upload.promise;
  } catch (error) {
    actions.markOptimisticFailed(optimisticId, error instanceof Error ? error.message : 'upload_error');
    throw error;
  }
  if (wireAttachments.length) {
    actions.replaceOptimisticAttachments(optimisticId, withRenderUris(wireAttachments, thumbs) ?? wireAttachments);
  }
  return wireAttachments;
}

