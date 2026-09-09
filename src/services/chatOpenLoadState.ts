export type ChatOpenRequestState = 'idle' | 'loading' | 'prefetching' | 'ready' | 'error';

export type ChatOpenLoadStateInput = {
  preview: boolean;
  retainedRows: number;
  connected: boolean;
  request: ChatOpenRequestState;
};

export type ChatOpenLoadState = {
  shell: 'preview' | 'empty' | 'none';
  list: 'deferred' | 'authoritative';
  spinner: boolean;
  status: 'syncing' | 'ready' | 'empty' | 'offline' | 'error';
};

/** The shell remains cheap; the authoritative list waits for interactions. */
export function shouldSelectChatOpenTranscript(
  isFocused: boolean,
  shellSelectorAvailable: boolean,
  transcriptReady: boolean,
): boolean {
  return isFocused && (!shellSelectorAvailable || transcriptReady);
}

/**
 * The mount-frame deferral above must not outlive real content. Rows that land
 * while the InteractionManager callback is still pending — the first assistant
 * event of a fresh chat is the common case — become visible immediately instead
 * of waiting for that flush; the mount frame itself stays deferred.
 */
export function shouldPromoteChatOpenTranscript(
  transcriptReady: boolean,
  baselineRetainedRows: number,
  retainedRows: number,
): boolean {
  return !transcriptReady && retainedRows > baselineRetainedRows;
}

/** Binding renderer for the observable chat-open state table. */
export function selectChatOpenLoadState(input: ChatOpenLoadStateInput): ChatOpenLoadState {
  const retainedRows = Math.max(0, input.retainedRows);
  const hasRows = retainedRows > 0;
  const hasPreview = input.preview && !hasRows;

  if (!input.connected) {
    return {
      shell: hasPreview ? 'preview' : 'none',
      list: hasRows ? 'authoritative' : 'deferred',
      spinner: false,
      status: 'offline',
    };
  }
  if (input.request === 'error') {
    return {
      shell: hasPreview ? 'preview' : 'none',
      list: hasRows ? 'authoritative' : 'deferred',
      spinner: false,
      status: 'error',
    };
  }
  if (hasRows) {
    return {
      shell: 'none',
      list: 'authoritative',
      spinner: false,
      status: input.request === 'loading' || input.request === 'prefetching' ? 'syncing' : 'ready',
    };
  }
  if (hasPreview) {
    return {
      shell: 'preview',
      list: 'deferred',
      spinner: false,
      status: input.request === 'ready' ? 'ready' : 'syncing',
    };
  }
  if (input.request === 'ready') {
    return { shell: 'empty', list: 'deferred', spinner: false, status: 'empty' };
  }
  return { shell: 'none', list: 'deferred', spinner: true, status: 'syncing' };
}
