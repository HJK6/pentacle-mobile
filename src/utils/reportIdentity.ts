// The same asset id can be published by different seats in one chat's tree.
export function reportIdentity(viewer: string, report: { stream_id?: string; asset_id: string }) {
  return JSON.stringify([report.stream_id || viewer, report.asset_id]);
}
