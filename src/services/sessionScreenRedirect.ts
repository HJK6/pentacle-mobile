export const MISSING_SESSION_REDIRECT_MS = 1500;

export type RedirectInputs = {
  isFocused: boolean;
  isReady: boolean;
  hasToken: boolean;
  hasSession: boolean;
  hasHydrated: boolean;
  connecting: boolean;
};

export function shouldArmRedirectTimer(inputs: RedirectInputs): boolean {
  return (
    inputs.isFocused
    && inputs.isReady
    && inputs.hasToken
    && !inputs.hasSession
    && inputs.hasHydrated
    && !inputs.connecting
  );
}
