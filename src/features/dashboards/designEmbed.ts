import { hostedDashboardOrigin } from './catalogLoader';

const DESIGN_EMBED_HOME = '/next/embed/design';
const DESIGN_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

type DesignRouteParams = {
  projectId?: unknown;
  designId?: unknown;
  viewId?: unknown;
};

export type DesignWebViewRequest = {
  url: string;
  isTopFrame?: boolean;
  hasTargetFrame?: boolean;
};

function isDesignId(value: unknown): value is string {
  return typeof value === 'string' && DESIGN_ID.test(value);
}

function isDesignTargetPath(path: string): boolean {
  if (path === DESIGN_EMBED_HOME) return true;
  if (!path.startsWith(`${DESIGN_EMBED_HOME}/`)) return false;

  const ids = path.slice(DESIGN_EMBED_HOME.length + 1).split('/');
  return (ids.length === 2 || ids.length === 3) && ids.every(isDesignId);
}

export function createDesignEmbed(policy: unknown, { projectId, designId, viewId }: DesignRouteParams) {
  const ids = viewId === undefined ? [projectId, designId] : [projectId, designId, viewId];
  const isHome = ids.every(id => id === undefined);
  if (!isHome && !ids.every(isDesignId)) return null;

  try {
    const origin = hostedDashboardOrigin(policy).origin;
    const path = isHome ? DESIGN_EMBED_HOME : `${DESIGN_EMBED_HOME}/${ids.join('/')}`;
    return { origin, uri: origin + path };
  } catch {
    return null;
  }
}

export function isDesignEmbedNavigationAllowed(origin: string, request: DesignWebViewRequest): boolean {
  if (request.hasTargetFrame === false) return false;
  const { url } = request;
  // The web viewer creates opaque sandboxed srcdoc frames for live screens.
  if (request.isTopFrame === false && (url === 'about:srcdoc' || url === 'about:blank')) return true;

  // Match the raw URL so dot segments, percent escapes and origin aliases cannot normalize into an allowed address.
  return url.startsWith(`${origin}/`) && isDesignTargetPath(url.slice(origin.length));
}
