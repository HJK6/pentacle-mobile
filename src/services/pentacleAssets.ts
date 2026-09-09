import { router } from "expo-router";
import { useSyncExternalStore } from "react";

import {
  sendPentacleAssetCommand,
  subscribePentacleAssetFrames,
} from "./pentacleStream";

export type ReportRun =
  | string
  | {
      type?: "text" | "code" | "link" | "chip";
      text?: string;
      chip?: string;
      href?: string;
      variant?: "plain" | "typed" | "status" | "link";
      kind?: string;
      status?: "ok" | "warn" | "stop" | "info";
    };
export type ReportBlock = {
  id: string;
  type: "para" | "table" | "callout" | "list";
  runs?: ReportRun[];
  title?: string;
  kind?: string;
  ordered?: boolean;
  items?: Array<ReportRun[] | string>;
  columns?: Array<string | { label?: string; key?: string }>;
  rows?: Array<ReportRun[][]>;
};
export type ReportSection = {
  id: string;
  title: string;
  status?: string;
  blocks: ReportBlock[];
};
export type ReportBody = {
  schema_version: number;
  title: string;
  sections: ReportSection[];
};

export type PentacleReport = {
  asset_id: string;
  title: string;
  content_type: string;
  tags?: string[];
  producer?: string;
  spec_id?: string | null;
  body?: string | ReportBody;
  read?: boolean;
  read_at?: string | null;
  created_at?: string;
  updated_at?: string;
  stream_id?: string;
};

export type AssetComment = {
  comment_id: string;
  asset_id: string;
  section_id: string;
  block_id: string;
  excerpt: string;
  body: string;
  author: string;
  created_at?: string;
  updated_at?: string;
  parent_comment_id?: string | null;
};

type AssetReply = Record<string, unknown> & {
  asset?: PentacleReport;
  assets?: PentacleReport[];
  comments?: AssetComment[];
  comment?: AssetComment;
  asset_id?: string;
};

const reportsByStream = new Map<string, PentacleReport[]>();
let reportViewerHarnessMode = false;

function isHarnessAssetMode() {
  return process.env.EXPO_PUBLIC_SCREENSHOT_HARNESS === "1" || reportViewerHarnessMode;
}
const harnessCommentsByAsset = new Map<string, AssetComment[]>();
const closedStreams = new Set<string>();
let harnessAssetError: string | null = null;
let harnessAssetLoading = false;
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version += 1;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot() {
  return version;
}

function sortLatestFirst(reports: PentacleReport[]) {
  return [...reports].sort((left, right) => {
    const leftAt = left.updated_at || left.created_at || "";
    const rightAt = right.updated_at || right.created_at || "";
    return (
      rightAt.localeCompare(leftAt) ||
      right.asset_id.localeCompare(left.asset_id)
    );
  });
}

function setReports(streamId: string, reports: PentacleReport[]) {
  reportsByStream.set(
    streamId,
    sortLatestFirst(reports.filter((asset) => asset.content_type === "report")),
  );
  emit();
}

function mergeReport(streamId: string, report: PentacleReport) {
  const current = reportsByStream.get(streamId) || [];
  setReports(streamId, [
    report,
    ...current.filter((item) => item.asset_id !== report.asset_id),
  ]);
}

function removeReport(streamId: string, assetId: string) {
  const current = reportsByStream.get(streamId) || [];
  setReports(
    streamId,
    current.filter((item) => item.asset_id !== assetId),
  );
}

function frameStreamId(
  message: Record<string, unknown>,
  asset?: PentacleReport,
) {
  const key = message.session_key as Record<string, unknown> | undefined;
  return String(message.stream_id || key?.stream_id || asset?.stream_id || "");
}

function reportFromUpdateFrame(
  message: Record<string, unknown>,
): PentacleReport | undefined {
  if (message.asset && typeof message.asset === "object")
    return message.asset as PentacleReport;
  if (typeof message.asset_id !== "string") return undefined;
  return {
    asset_id: message.asset_id,
    title: String(message.title || "Untitled report"),
    content_type: String(message.content_type || ""),
    tags: Array.isArray(message.tags) ? message.tags.map(String) : undefined,
    producer:
      typeof message.producer === "string" ? message.producer : undefined,
    spec_id: typeof message.spec_id === "string" ? message.spec_id : null,
    read: typeof message.read === "boolean" ? message.read : undefined,
    read_at:
      typeof message.read_at === "string" || message.read_at === null
        ? message.read_at
        : undefined,
    created_at:
      typeof message.created_at === "string" ? message.created_at : undefined,
    updated_at:
      typeof message.updated_at === "string" ? message.updated_at : undefined,
  };
}

function applyAssetFrame(message: Record<string, unknown>) {
  const type = String(message.type || "");
  const asset =
    type === "asset.update"
      ? reportFromUpdateFrame(message)
      : (message.asset as PentacleReport | undefined);
  const streamId = frameStreamId(message, asset);
  if (type === "asset.update" && asset?.content_type === "report" && streamId) {
    mergeReport(streamId, asset);
  } else if (type === "asset.removed" && streamId) {
    removeReport(streamId, String(message.asset_id || asset?.asset_id || ""));
  } else if (type === "asset.session_closed" && streamId) {
    closedStreams.add(streamId);
    emit();
  }
}

if (typeof subscribePentacleAssetFrames === "function") {
  subscribePentacleAssetFrames(applyAssetFrame);
}

async function command(payload: Record<string, unknown>) {
  return sendPentacleAssetCommand<AssetReply>(payload);
}

export function getSessionReports(streamId: string) {
  return reportsByStream.get(streamId) || [];
}

export function useSessionReports(streamId: string) {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return getSessionReports(streamId);
}

export function selectSessionReportAction(streamId: string): {
  hasReports: boolean;
  reportUnread: boolean;
} {
  const reports = getSessionReports(streamId);
  return {
    hasReports: reports.length > 0,
    reportUnread: reports.some(
      (report) =>
        (typeof report.read === "boolean" || report.read_at !== undefined) &&
        report.read !== true &&
        !report.read_at,
    ),
  };
}

export function reportUnreadCount(streamId: string) {
  return getSessionReports(streamId).filter(
    (report) =>
      (typeof report.read === "boolean" || report.read_at !== undefined) &&
      report.read !== true &&
      !report.read_at,
  ).length;
}

export function isReportSessionClosed(streamId: string) {
  return closedStreams.has(streamId);
}

export async function listReports(streamId: string) {
  if (isHarnessAssetMode()) {
    if (harnessAssetError) throw new Error(harnessAssetError);
    if (harnessAssetLoading) return new Promise<PentacleReport[]>(() => undefined);
    return getSessionReports(streamId);
  }
  const reply = await command({
    type: "asset.list",
    stream_id: streamId,
    content_type: "report",
  });
  const reports = Array.isArray(reply.assets) ? reply.assets : [];
  setReports(streamId, reports);
  return getSessionReports(streamId);
}

export async function getReport(streamId: string, report: PentacleReport) {
  if (isHarnessAssetMode()) {
    if (harnessAssetError) throw new Error(harnessAssetError);
    return (
      getSessionReports(streamId).find(
        (item) => item.asset_id === report.asset_id,
      ) || report
    );
  }
  const reply = await command({
    type: "asset.get",
    stream_id: streamId,
    asset_id: report.asset_id,
    ...(report.spec_id ? { spec_id: report.spec_id } : {}),
  });
  if (!reply.asset) throw new Error("Report was not returned");
  mergeReport(streamId, reply.asset);
  return reply.asset;
}

export async function listReportComments(
  streamId: string,
  report: PentacleReport,
) {
  if (isHarnessAssetMode()) {
    if (harnessAssetError) throw new Error(harnessAssetError);
    return harnessCommentsByAsset.get(`${streamId}:${report.asset_id}`) || [];
  }
  const reply = await command({
    type: "asset.comments.list",
    stream_id: streamId,
    asset_id: report.asset_id,
    ...(report.spec_id ? { spec_id: report.spec_id } : {}),
  });
  return Array.isArray(reply.comments) ? reply.comments : [];
}

export async function addReportComment(args: {
  streamId: string;
  report: PentacleReport;
  sectionId: string;
  blockId: string;
  excerpt: string;
  body: string;
}) {
  if (isHarnessAssetMode()) {
    if (harnessAssetError) throw new Error(harnessAssetError);
    const key = `${args.streamId}:${args.report.asset_id}`;
    const current = harnessCommentsByAsset.get(key) || [];
    const comment: AssetComment = {
      comment_id: `harness-comment-${current.length + 1}`,
      asset_id: args.report.asset_id,
      section_id: args.sectionId,
      block_id: args.blockId,
      excerpt: args.excerpt,
      body: args.body.trim(),
      author: "operator@mobile",
      created_at: new Date().toISOString(),
    };
    harnessCommentsByAsset.set(key, [...current, comment]);
    emit();
    return comment;
  }
  const reply = await command({
    type: "asset.comment.add",
    stream_id: args.streamId,
    asset_id: args.report.asset_id,
    section_id: args.sectionId,
    block_id: args.blockId,
    excerpt: args.excerpt,
    body: args.body.trim(),
    ...(args.report.spec_id ? { spec_id: args.report.spec_id } : {}),
  });
  if (!reply.comment) throw new Error("Comment was not returned");
  return reply.comment;
}

export async function deleteReportComment(
  streamId: string,
  report: PentacleReport,
  commentId: string,
) {
  await command({
    type: "asset.comment.delete",
    stream_id: streamId,
    asset_id: report.asset_id,
    comment_id: commentId,
    ...(report.spec_id ? { spec_id: report.spec_id } : {}),
  });
}

export async function sendReportCommentsToChat(
  streamId: string,
  report: PentacleReport,
) {
  if (isHarnessAssetMode()) {
    if (harnessAssetError) throw new Error(harnessAssetError);
    return {
      sent_count: (harnessCommentsByAsset.get(`${streamId}:${report.asset_id}`) || []).length,
    };
  }
  return command({
    type: "asset.comments.send_to_chat",
    stream_id: streamId,
    asset_id: report.asset_id,
    ...(report.spec_id ? { spec_id: report.spec_id } : {}),
  });
}

export async function markReportRead(streamId: string, report: PentacleReport) {
  const reply = await command({
    type: "asset.read.set",
    stream_id: streamId,
    asset_id: report.asset_id,
    read: true,
    ...(report.spec_id ? { spec_id: report.spec_id } : {}),
  });
  if (reply.asset) mergeReport(streamId, reply.asset);
}

export async function deleteReport(streamId: string, report: PentacleReport) {
  await command({
    type: "asset.delete",
    stream_id: streamId,
    asset_id: report.asset_id,
    ...(report.spec_id ? { spec_id: report.spec_id } : {}),
  });
  removeReport(streamId, report.asset_id);
}

export async function openReports(streamId: string) {
  await listReports(streamId);
  router.push({
    pathname: "/pentacle/session/[streamId]",
    params: { streamId, reports: "1" },
  } as never);
}

export function parseReportBody(report: PentacleReport): ReportBody {
  const body =
    typeof report.body === "string" ? JSON.parse(report.body) : report.body;
  if (!body || !Array.isArray(body.sections))
    throw new Error("This report has an unsupported document shape");
  return body as ReportBody;
}

export function reportRunText(run: ReportRun) {
  if (typeof run === "string") return run;
  return String(run.text || run.chip || "");
}

export function reportBlockText(block: ReportBlock) {
  if (Array.isArray(block.runs)) return block.runs.map(reportRunText).join("");
  if (Array.isArray(block.items)) {
    return block.items
      .map((item) =>
        typeof item === "string" ? item : item.map(reportRunText).join(""),
      )
      .join("\n");
  }
  if (block.type === "table") {
    return [
      ...(block.columns || []).map(String),
      ...(block.rows || []).flatMap((row) =>
        row.map((cell) => cell.map(reportRunText).join("")),
      ),
    ].join(" | ");
  }
  return block.title || block.type;
}

export function __resetPentacleAssetsForTests() {
  reportsByStream.clear();
  harnessCommentsByAsset.clear();
  closedStreams.clear();
  harnessAssetError = null;
  harnessAssetLoading = false;
  version = 0;
  reportViewerHarnessMode = false;
}

export function enableReportViewerHarnessMode() {
  reportViewerHarnessMode = true;
}

export function harnessSeedReports(
  streamId: string,
  reports: PentacleReport[] = [],
  comments: AssetComment[] = [],
  closed = false,
  error: string | null = null,
  loading = false,
) {
  harnessAssetError = error;
  harnessAssetLoading = loading;
  reportsByStream.clear();
  harnessCommentsByAsset.clear();
  closedStreams.clear();
  setReports(
    streamId,
    reports.map((report) => ({ ...report, stream_id: streamId })),
  );
  reports.forEach((report) =>
    harnessCommentsByAsset.set(
      `${streamId}:${report.asset_id}`,
      comments.filter((comment) => comment.asset_id === report.asset_id),
    ),
  );
  if (closed) closedStreams.add(streamId);
  emit();
}

export function __handlePentacleAssetFrameForTests(
  message: Record<string, unknown>,
) {
  applyAssetFrame(message);
}
