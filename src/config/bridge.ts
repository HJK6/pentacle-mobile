import { getBackendWsUrl } from './local';

export function getBridgeWsUrl() {
  return getBackendWsUrl();
}

export function getBridgeHttpUrl() {
  const url = new URL(getBackendWsUrl());
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  return url.toString();
}
