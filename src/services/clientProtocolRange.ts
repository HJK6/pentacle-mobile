export const CLIENT_PROTOCOL_RANGE = { min: 2, max: 2 } as const;

export function classifyWelcomeRange(welcome: Record<string, unknown>): 'compatible' | 'invalid' | 'app_too_old' | 'daemon_too_old' {
  const hasMin = Object.prototype.hasOwnProperty.call(welcome, 'min_protocol_version');
  const hasMax = Object.prototype.hasOwnProperty.call(welcome, 'max_protocol_version');
  if (!hasMin && !hasMax) return 'compatible';
  const min = welcome.min_protocol_version;
  const max = welcome.max_protocol_version;
  if (!hasMin || !hasMax || typeof min !== 'number' || typeof max !== 'number' ||
      !Number.isInteger(min) || !Number.isInteger(max) || min > max) return 'invalid';
  if (CLIENT_PROTOCOL_RANGE.max < min) return 'app_too_old';
  if (CLIENT_PROTOCOL_RANGE.min > max) return 'daemon_too_old';
  return 'compatible';
}

export function protocolMismatchMessage(error: string | undefined): string | undefined {
  if (error === 'app_too_old') return 'This app is too old for your Pentacle daemon. Update the app.';
  if (error === 'daemon_too_old') return 'Your Pentacle daemon is too old for this app. Update the daemon.';
  return undefined;
}
