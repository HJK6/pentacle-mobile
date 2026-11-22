import { buildDesignPath, type DesignTarget } from 'pentacle-chat-core';
import { hostedDashboardOrigin } from './catalogLoader';

const DESIGN_EMBED_HOME = buildDesignPath(undefined, 'embed');

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

export function designDashboardHref(target?: DesignTarget) {
  return {
    pathname: '/pentacle/dashboard/[dashboardId]',
    params: {
      dashboardId: 'design',
      ...(target ? {
        projectId: target.project_id,
        designId: target.design_id,
        ...(target.view_id === undefined ? {} : { viewId: target.view_id }),
      } : {}),
    },
  } as const;
}

function isDesignTargetPath(path: string): boolean {
  if (path === DESIGN_EMBED_HOME) return true;
  if (!DESIGN_EMBED_HOME || !path.startsWith(`${DESIGN_EMBED_HOME}/`)) return false;

  const [projectId, designId, viewId, ...extra] = path.slice(DESIGN_EMBED_HOME.length + 1).split('/');
  return !extra.length && designPath({ projectId, designId, viewId }) === path;
}

function designPath({ projectId, designId, viewId }: DesignRouteParams) {
  if (projectId === undefined && designId === undefined && viewId === undefined) return DESIGN_EMBED_HOME;
  if (typeof projectId !== 'string' || typeof designId !== 'string') return null;
  if (viewId !== undefined && typeof viewId !== 'string') return null;
  return buildDesignPath({
    project_id: projectId,
    design_id: designId,
    ...(viewId === undefined ? {} : { view_id: viewId }),
  }, 'embed');
}

export function createDesignEmbed(policy: unknown, target: DesignRouteParams) {
  const path = designPath(target);
  if (!path) return null;

  try {
    const origin = hostedDashboardOrigin(policy).origin;
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
