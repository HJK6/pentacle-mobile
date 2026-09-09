import { getBackendWsUrl } from './local';

export function getDefaultPentacleWsUrl() {
  return process.env.EXPO_PUBLIC_PENTACLE_WS_URL || getBackendWsUrl();
}
