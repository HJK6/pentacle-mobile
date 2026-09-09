import React from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
} from "react-native";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react-native";

const mockReport = {
  asset_id: "report-1",
  title: "Metadata title",
  content_type: "report",
  producer: "operator@example.com",
  read: false,
  read_at: null,
  updated_at: "2026-07-11T10:00:00Z",
  body: JSON.stringify({
    schema_version: 1,
    title: "Implementation review",
    sections: [
      {
        id: "section-1",
        title: "Findings",
        status: "attention",
        blocks: [
          {
            id: "para-1",
            type: "para",
            runs: [
              "Keep ",
              { chip: "request_id", variant: "typed", kind: "file" },
              " stable.",
            ],
          },
          {
            id: "list-1",
            type: "list",
            ordered: false,
            items: [["First item"], ["Second item"]],
          },
          {
            id: "callout-1",
            type: "callout",
            kind: "warning",
            title: "Risk",
            runs: ["Stale response"],
          },
          {
            id: "table-1",
            type: "table",
            columns: ["Gate", "State", "Owner", "Evidence", "Disposition"],
            rows: [
              [
                [{ type: "code", text: "Typecheck" }],
                [{ chip: "Pass", status: "ok" }],
                ["Mobile QA"],
                ["Release replay"],
                ["Verified"],
              ],
            ],
          },
        ],
      },
    ],
  }),
};
type MockReport = Omit<typeof mockReport, 'read_at'> & { read_at: string | null };
let mockReports: MockReport[] = [mockReport];
let mockComments = [
  {
    comment_id: "comment-1",
    asset_id: "report-1",
    section_id: "section-1",
    block_id: "para-1",
    excerpt: "Keep request_id stable.",
    body: "Please retain this.",
    author: "operator@example.com",
  },
];
const mockAdd = jest.fn();
const mockDeleteComment = jest.fn();
const mockSendAll = jest.fn();
const mockDeleteReport = jest.fn();
const mockMarkRead = jest.fn();
const mockListReports = jest.fn();
const mockGetReport = jest.fn();
const mockListComments = jest.fn();
let mockSessionClosed = false;

jest.mock("../src/services/pentacleAssets", () => ({
  useSessionReports: () => mockReports,
  isReportSessionClosed: () => mockSessionClosed,
  listReports: (...args: unknown[]) => mockListReports(...args),
  getReport: (...args: unknown[]) => mockGetReport(...args),
  listReportComments: (...args: unknown[]) => mockListComments(...args),
  markReportRead: (...args: unknown[]) => mockMarkRead(...args),
  addReportComment: (...args: unknown[]) => mockAdd(...args),
  deleteReportComment: (...args: unknown[]) => mockDeleteComment(...args),
  sendReportCommentsToChat: (...args: unknown[]) => mockSendAll(...args),
  deleteReport: (...args: unknown[]) => mockDeleteReport(...args),
  parseReportBody: (report: typeof mockReport) => JSON.parse(report.body),
  reportRunText: (run: string | { text?: string; chip?: string }) =>
    typeof run === "string" ? run : run.text || run.chip || "",
  reportBlockText: (block: {
    runs?: Array<string | { text?: string; chip?: string }>;
    title?: string;
  }) =>
    block.runs
      ?.map((run) =>
        typeof run === "string" ? run : run.text || run.chip || "",
      )
      .join("") ||
    block.title ||
    "",
}));

import ReportViewerModal from "../src/components/ReportViewerModal";

const platformOSDescriptor = Object.getOwnPropertyDescriptor(Platform, "OS");

class TestErrorBoundary extends React.Component<
  React.PropsWithChildren,
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? (
      <Text testID="viewer-error">{this.state.error.message}</Text>
    ) : (
      this.props.children
    );
  }
}

function renderViewer(onClose = jest.fn(), e2eTableTargets = false) {
  return render(
    <TestErrorBoundary>
      <ReportViewerModal visible streamId="hostc:chat" onClose={onClose} e2eTableTargets={e2eTableTargets} />
    </TestErrorBoundary>,
  );
}

beforeEach(() => {
  mockComments = [
    {
      comment_id: "comment-1",
      asset_id: "report-1",
      section_id: "section-1",
      block_id: "para-1",
      excerpt: "Keep request_id stable.",
      body: "Please retain this.",
      author: "operator@example.com",
    },
  ];
  mockReports = [mockReport];
  mockSessionClosed = false;
  mockListReports.mockReset().mockResolvedValue(mockReports);
  mockGetReport.mockReset().mockResolvedValue(mockReport);
  mockListComments
    .mockReset()
    .mockImplementation(() => Promise.resolve(mockComments));
  mockAdd
    .mockReset()
    .mockResolvedValue({
      ...mockComments[0],
      comment_id: "comment-2",
      body: "New note",
    });
  mockDeleteComment.mockReset().mockResolvedValue(undefined);
  mockSendAll.mockReset().mockResolvedValue({ sent: 1 });
  mockDeleteReport.mockReset().mockResolvedValue(undefined);
  mockMarkRead.mockReset().mockResolvedValue(undefined);
  jest.spyOn(Alert, "alert").mockImplementation(jest.fn());
});

afterEach(() => {
  if (platformOSDescriptor) {
    Object.defineProperty(Platform, "OS", platformOSDescriptor);
  }
});

afterEach(() => jest.restoreAllMocks());

test("renders the deterministic document types and preserves collapse interaction", async () => {
  renderViewer();
  await waitFor(() =>
    expect(screen.getByText("Keep ")).toBeTruthy(),
  );
  expect(screen.getByText(/request_id/)).toBeTruthy();
  expect(screen.getByText("First item")).toBeTruthy();
  expect(screen.getByText(/Risk/)).toBeTruthy();
  expect(screen.getByText("Typecheck")).toBeTruthy();
  expect(screen.getByText("Pass")).toBeTruthy();
  expect(screen.getByTestId("report-table-scroll-table-1").props.horizontal).toBe(true);
  expect(screen.getByTestId("report-table-scroll-table-1").props.pagingEnabled).toBe(true);
  expect(StyleSheet.flatten(screen.getByTestId("report-table-scroll-table-1").props.contentContainerStyle))
    .toEqual(expect.objectContaining({ paddingRight: 12 }));
  expect(screen.getByTestId("report-table-scroll-table-1").props.accessible).not.toBe(true);
  expect(screen.getByTestId("report-table-right-edge-table-1").props.accessible).not.toBe(true);
  expect(screen.getByTestId("report-table-right-edge-table-1").props.pointerEvents).toBeUndefined();
  expect(screen.getByTestId("report-block-para-1").props.accessibilityRole).toBeUndefined();
  expect(screen.getByTestId("report-block-para-1").props.accessibilityLabel).toBeUndefined();
  expect(screen.getByTestId("report-table-scroll-table-1").props.style).toEqual(expect.objectContaining({ width: "100%", maxWidth: "100%" }));
  expect(StyleSheet.flatten(screen.getByTestId("report-table-content-table-1").props.style))
    .toEqual(expect.objectContaining({ width: 715 }));
  expect(screen.getByTestId("report-header-meta")).toHaveTextContent(
    /operator@example.com/,
  );
  expect(screen.getByTestId("report-chip-rail")).toBeTruthy();
  expect(screen.getByTestId("report-document-title").props.style).toEqual(
    expect.objectContaining({ fontFamily: "SpaceGrotesk_600SemiBold" }),
  );
  expect(mockMarkRead).toHaveBeenCalledWith(
    "hostc:chat",
    expect.objectContaining({ asset_id: "report-1" }),
  );

  fireEvent.press(screen.getByTestId("report-section-section-1"));
  expect(screen.queryByTestId("report-block-para-1")).toBeNull();
  fireEvent.press(screen.getByTestId("report-section-section-1"));
  expect(screen.getByTestId("report-block-para-1")).toBeTruthy();
}, 15_000);

test("exposes independent table geometry targets only for the exact E2E viewer", async () => {
  renderViewer(jest.fn(), true);
  await waitFor(() => expect(screen.getByText("Keep ")).toBeTruthy());

  expect(screen.getByTestId("report-table-scroll-table-1").props.accessible).toBe(true);
  expect(screen.getByTestId("report-table-scroll-table-1").props.pointerEvents).toBe("none");
  expect(screen.getByTestId("report-table-scroll-table-1").props.collapsable).toBe(false);
  expect(screen.getByTestId("report-table-content-table-1").props.accessible).toBe(true);
  expect(screen.getByTestId("report-table-content-table-1").props.collapsable).toBe(false);
  expect(screen.getByTestId("report-table-right-edge-table-1").props.accessible).toBe(true);
  expect(screen.getByTestId("report-table-right-edge-table-1").props.pointerEvents).toBe("none");
  expect(screen.getByTestId("report-table-right-edge-table-1").props.collapsable).toBe(false);
  expect(screen.getByTestId("report-table-right-edge-table-1").props.accessibilityLabel).toBe(
    "Report table right-edge geometry",
  );
  const commentTarget = screen.getByTestId("report-block-para-1");
  expect(commentTarget.props.accessible).toBe(true);
  expect(commentTarget.props.collapsable).toBe(false);
  expect(commentTarget.props.pointerEvents).toBe("none");
  expect(commentTarget.props.onPress).toBeUndefined();
  expect(commentTarget.props.accessibilityLabel).toBe("Report block comment target");
  const commentInteraction = screen.getByTestId("report-block-interaction-para-1");
  expect(commentInteraction.props.accessible).toBe(false);
  const commentHarness = screen.getByTestId("report-block-harness-para-1");
  expect(within(commentHarness).getByTestId("report-block-para-1")).toBe(commentTarget);
  expect(within(commentHarness).getByTestId("report-block-interaction-para-1")).toBe(
    commentInteraction,
  );
  fireEvent.press(commentInteraction);
  expect(screen.getByTestId("report-comment-sheet")).toBeTruthy();
});

test("keeps the table scroll surface outside the block comment press target", async () => {
  renderViewer();
  await waitFor(() => expect(screen.getByText("Keep ")).toBeTruthy());

  expect(screen.getByTestId("report-block-table-1").props.onPress).toBeUndefined();
  const commentAction = screen.getByTestId("report-table-comment-table-1");
  expect(commentAction.props.accessibilityRole).toBe("button");
  fireEvent.press(commentAction);
  expect(screen.getByTestId("report-comment-sheet")).toBeTruthy();
});

test("keeps the loading state until the asynchronously fetched report body is ready", async () => {
  let resolveReport: ((report: typeof mockReport) => void) | undefined;
  mockGetReport.mockReturnValueOnce(
    new Promise<typeof mockReport>((resolve) => {
      resolveReport = resolve;
    }),
  );
  renderViewer();
  await waitFor(() =>
    expect(screen.getByTestId("report-body-loading")).toBeTruthy(),
  );
  expect(screen.getByTestId("report-reader-title")).toBeTruthy();
  expect(mockGetReport).toHaveBeenCalled();
  expect(screen.queryByText("Keep ")).toBeNull();
  await act(async () => resolveReport?.(mockReport));
  await waitFor(() => expect(screen.getByText("Keep ")).toBeTruthy());
  expect(screen.queryByTestId("report-body-loading")).toBeNull();
});

test("switching reports closes a thread so repeated block ids cannot submit to the wrong asset", async () => {
  const second = {
    ...mockReport,
    asset_id: "report-2",
    title: "Second metadata",
    updated_at: "2026-07-10T10:00:00Z",
  };
  mockReports = [mockReport, second];
  mockListReports.mockResolvedValue(mockReports);
  mockGetReport.mockImplementation(
    (_streamId: string, report: typeof mockReport) => Promise.resolve(report),
  );
  renderViewer();
  await waitFor(() =>
    expect(screen.getByTestId("report-block-para-1")).toBeTruthy(),
  );
  fireEvent.press(screen.getByTestId("report-block-para-1"));
  expect(screen.getByTestId("report-comment-sheet")).toBeTruthy();
  await act(async () =>
    fireEvent.press(screen.getByTestId("report-chip-report-2")),
  );
  await waitFor(() =>
    expect(screen.queryByTestId("report-comment-sheet")).toBeNull(),
  );
});

test("opens the latest unread report and marks both the initial and switched report read", async () => {
  const readLatest = {
    ...mockReport,
    asset_id: "report-read",
    title: "Read latest",
    read: true,
    read_at: "2026-07-11T10:00:00Z",
  };
  const unreadOlder = {
    ...mockReport,
    asset_id: "report-unread",
    title: "Unread older",
    updated_at: "2026-07-10T10:00:00Z",
  };
  mockReports = [readLatest, unreadOlder];
  mockListReports.mockResolvedValue(mockReports);
  mockGetReport.mockImplementation(
    (_streamId: string, report: typeof mockReport) => Promise.resolve(report),
  );
  renderViewer();
  await waitFor(() =>
    expect(mockMarkRead).toHaveBeenCalledWith(
      "hostc:chat",
      expect.objectContaining({ asset_id: "report-unread" }),
    ),
  );
  fireEvent.press(screen.getByTestId("report-chip-report-read"));
  await waitFor(() =>
    expect(mockMarkRead).toHaveBeenCalledWith(
      "hostc:chat",
      expect.objectContaining({ asset_id: "report-read" }),
    ),
  );
});

test("live report updates refresh the active reader and removing it falls back to the next report", async () => {
  const second = {
    ...mockReport,
    asset_id: "report-2",
    title: "Second metadata",
    updated_at: "2026-07-10T10:00:00Z",
  };
  const view = renderViewer();
  await waitFor(() =>
    expect(screen.getByTestId("report-reader-title")).toBeTruthy(),
  );
  const updated = {
    ...mockReport,
    title: "Live update",
    updated_at: "2026-07-12T10:00:00Z",
  };
  mockReports = [updated, second];
  mockGetReport.mockImplementation(
    (_streamId: string, report: typeof mockReport) => Promise.resolve(report),
  );
  view.rerender(
    <TestErrorBoundary>
      <ReportViewerModal visible streamId="hostc:chat" onClose={jest.fn()} />
    </TestErrorBoundary>,
  );
  await waitFor(() =>
    expect(screen.getByTestId("report-reader-title")).toHaveTextContent(
      "Implementation review",
    ),
  );
  mockReports = [second];
  view.rerender(
    <TestErrorBoundary>
      <ReportViewerModal visible streamId="hostc:chat" onClose={jest.fn()} />
    </TestErrorBoundary>,
  );
  await waitFor(() =>
    expect(mockGetReport).toHaveBeenCalledWith(
      "hostc:chat",
      expect.objectContaining({ asset_id: "report-2" }),
    ),
  );
});

test("block thread adds optimistically, deletes own comments, and sends the report from the thread", async () => {
  renderViewer(jest.fn(), true);
  await waitFor(() =>
    expect(screen.getByTestId("report-block-para-1")).toBeTruthy(),
  );
  fireEvent.press(screen.getByTestId("report-block-interaction-para-1"));
  expect(screen.getByText("Please retain this.")).toBeTruthy();
  expect(screen.getByTestId("report-comment-comment-1")).toBeTruthy();

  fireEvent.changeText(screen.getByTestId("report-comment-input"), "New note");
  await act(async () =>
    fireEvent.press(screen.getByTestId("report-comment-send")),
  );
  expect(mockAdd).toHaveBeenCalledWith(
    expect.objectContaining({
      streamId: "hostc:chat",
      sectionId: "section-1",
      blockId: "para-1",
      excerpt: "Keep request_id stable.",
      body: "New note",
    }),
  );
  const confirmedComment = screen.getByTestId("report-comment-comment-2");
  expect(confirmedComment.props.accessible).toBe(true);
  expect(confirmedComment.props.collapsable).toBe(false);
  expect(screen.getByText("New note")).toBeTruthy();

  await act(async () =>
    fireEvent.press(screen.getByTestId("delete-comment-comment-1")),
  );
  expect(mockDeleteComment).toHaveBeenCalledWith(
    "hostc:chat",
    expect.objectContaining({ asset_id: "report-1" }),
    "comment-1",
  );

  await act(async () =>
    fireEvent.press(screen.getByTestId("report-thread-send-to-chat")),
  );
  expect(mockSendAll).toHaveBeenCalledWith(
    "hostc:chat",
    expect.objectContaining({ asset_id: "report-1" }),
  );
});

test("does not expose a comment from another block in the active thread", async () => {
  mockListComments.mockResolvedValueOnce([
    ...mockComments,
    {
      ...mockComments[0],
      comment_id: "other-block-comment",
      block_id: "para-2",
      body: "Wrong thread",
    },
  ]);
  renderViewer();
  await waitFor(() =>
    expect(screen.getByTestId("report-block-para-1")).toBeTruthy(),
  );
  fireEvent.press(screen.getByTestId("report-block-para-1"));

  expect(screen.queryByTestId("report-comment-other-block-comment")).toBeNull();
  expect(screen.queryByText("Wrong thread")).toBeNull();
});

test("send-to-chat persists a draft before dispatching the report comments", async () => {
  mockComments = [];
  renderViewer();
  await waitFor(() =>
    expect(screen.getByTestId("report-block-para-1")).toBeTruthy(),
  );
  fireEvent.press(screen.getByTestId("report-block-para-1"));
  fireEvent.changeText(
    screen.getByTestId("report-comment-input"),
    "Draft only",
  );

  await act(async () =>
    fireEvent.press(screen.getByTestId("report-thread-send-to-chat")),
  );

  expect(mockAdd).toHaveBeenCalledWith(
    expect.objectContaining({ body: "Draft only" }),
  );
  await waitFor(() => expect(mockSendAll).toHaveBeenCalledTimes(1));
  expect(mockAdd.mock.invocationCallOrder[0]).toBeLessThan(
    mockSendAll.mock.invocationCallOrder[0],
  );
});

test("send-to-chat is explicitly disabled for a truly empty thread", async () => {
  mockComments = [];
  renderViewer();
  await waitFor(() =>
    expect(screen.getByTestId("report-block-para-1")).toBeTruthy(),
  );
  fireEvent.press(screen.getByTestId("report-block-para-1"));

  const send = screen.getByTestId("report-thread-send-to-chat");
  expect(send).toBeDisabled();
  fireEvent.press(send);
  expect(mockAdd).not.toHaveBeenCalled();
  expect(mockSendAll).not.toHaveBeenCalled();
});

test("send-to-chat dispatches existing comments without adding another", async () => {
  renderViewer();
  await waitFor(() =>
    expect(screen.getByTestId("report-block-para-1")).toBeTruthy(),
  );
  fireEvent.press(screen.getByTestId("report-block-para-1"));

  await act(async () =>
    fireEvent.press(screen.getByTestId("report-thread-send-to-chat")),
  );

  expect(mockAdd).not.toHaveBeenCalled();
  expect(mockSendAll).toHaveBeenCalledTimes(1);
});

test("rejected draft persistence restores the draft and prevents send-to-chat", async () => {
  mockAdd.mockRejectedValueOnce(new Error("offline"));
  renderViewer();
  await waitFor(() =>
    expect(screen.getByTestId("report-block-para-1")).toBeTruthy(),
  );
  fireEvent.press(screen.getByTestId("report-block-para-1"));
  fireEvent.changeText(
    screen.getByTestId("report-comment-input"),
    "Retry this note",
  );
  await act(async () =>
    fireEvent.press(screen.getByTestId("report-thread-send-to-chat")),
  );
  await waitFor(() =>
    expect(screen.getByTestId("report-comment-input").props.value).toBe(
      "Retry this note",
    ),
  );
  expect(Alert.alert).toHaveBeenCalledWith("Comment not sent", "offline");
  expect(mockSendAll).not.toHaveBeenCalled();
});

test("a live close hides the opened thread mutations without persisting its draft", async () => {
  const view = renderViewer();
  await waitFor(() =>
    expect(screen.getByTestId("report-block-para-1")).toBeTruthy(),
  );
  fireEvent.press(screen.getByTestId("report-block-para-1"));
  fireEvent.changeText(
    screen.getByTestId("report-comment-input"),
    "Do not persist after close",
  );

  mockSessionClosed = true;
  view.rerender(
    <TestErrorBoundary>
      <ReportViewerModal visible streamId="hostc:chat" onClose={jest.fn()} />
    </TestErrorBoundary>,
  );

  await waitFor(() =>
    expect(screen.queryByTestId("report-comment-input")).toBeNull(),
  );
  expect(screen.queryByTestId("report-thread-send-to-chat")).toBeNull();
  expect(mockAdd).not.toHaveBeenCalled();
  expect(mockSendAll).not.toHaveBeenCalled();
});

test("keeps the focused iOS report comment composer above the keyboard", async () => {
  Object.defineProperty(Platform, "OS", {
    configurable: true,
    value: "ios",
  });
  renderViewer();
  await waitFor(() =>
    expect(screen.getByTestId("report-block-para-1")).toBeTruthy(),
  );
  fireEvent.press(screen.getByTestId("report-block-para-1"));

  const sheet = screen.getByTestId("report-comment-sheet");
  const avoider = screen.UNSAFE_getByType(KeyboardAvoidingView);
  const input = within(
    screen.getByTestId("report-comment-keyboard-avoider"),
  ).getByTestId("report-comment-input");
  const commentList = screen
    .UNSAFE_getAllByType(ScrollView)
    .find((node) => node.props.testID === "report-comment-list");
  expect(commentList).toBeTruthy();
  const scrollToEnd = commentList!.instance.scrollToEnd as jest.Mock;
  scrollToEnd.mockClear();
  expect(avoider.props.behavior).toBe("padding");
  expect(avoider.props.enabled).toBe(true);
  expect(
    screen.getByTestId("report-comment-list").props
      .automaticallyAdjustKeyboardInsets,
  ).toBe(false);

  fireEvent(input, "focus");
  expect(scrollToEnd).toHaveBeenCalledTimes(1);
  expect(scrollToEnd).toHaveBeenCalledWith({ animated: true });
  fireEvent.changeText(input, "Visible first line\nVisible second line");

  expect(screen.getByTestId("report-comment-sheet")).toBe(sheet);
  expect(screen.getByTestId("report-comment-input")).toBe(input);
  expect(screen.getByTestId("report-comment-input").props.value).toBe(
    "Visible first line\nVisible second line",
  );
  expect(screen.getByText("Keep request_id stable.")).toBeTruthy();
});

test("does not stack report-thread keyboard adjustment on Android", async () => {
  Object.defineProperty(Platform, "OS", {
    configurable: true,
    value: "android",
  });
  renderViewer();
  await waitFor(() =>
    expect(screen.getByTestId("report-block-para-1")).toBeTruthy(),
  );
  fireEvent.press(screen.getByTestId("report-block-para-1"));

  const avoider = screen.UNSAFE_getByType(KeyboardAvoidingView);
  expect(avoider.props.behavior).toBeUndefined();
  expect(avoider.props.enabled).toBe(false);
  expect(
    screen.getByTestId("report-comment-list").props
      .automaticallyAdjustKeyboardInsets,
  ).toBe(false);
});

test("rejected optimistic add restores the draft for retry", async () => {
  mockAdd.mockRejectedValueOnce(new Error("offline"));
  renderViewer();
  await waitFor(() =>
    expect(screen.getByTestId("report-block-para-1")).toBeTruthy(),
  );
  fireEvent.press(screen.getByTestId("report-block-para-1"));
  fireEvent.changeText(
    screen.getByTestId("report-comment-input"),
    "Retry this note",
  );
  await act(async () =>
    fireEvent.press(screen.getByTestId("report-comment-send")),
  );
  await waitFor(() =>
    expect(screen.getByTestId("report-comment-input").props.value).toBe(
      "Retry this note",
    ),
  );
  expect(Alert.alert).toHaveBeenCalledWith("Comment not sent", "offline");
});

test("rejected send-to-chat remains surfaced to the operator", async () => {
  mockSendAll.mockRejectedValueOnce(new Error("chat unavailable"));
  renderViewer();
  await waitFor(() =>
    expect(screen.getByTestId("report-block-para-1")).toBeTruthy(),
  );
  fireEvent.press(screen.getByTestId("report-block-para-1"));
  await act(async () =>
    fireEvent.press(screen.getByTestId("report-thread-send-to-chat")),
  );
  expect(Alert.alert).toHaveBeenCalledWith(
    "Comments not sent",
    "chat unavailable",
  );
});

test("removing the last report closes the overlay", async () => {
  const onClose = jest.fn();
  const view = renderViewer(onClose);
  await waitFor(() =>
    expect(screen.getByTestId("report-reader-title")).toBeTruthy(),
  );
  mockReports = [];
  view.rerender(
    <TestErrorBoundary>
      <ReportViewerModal visible streamId="hostc:chat" onClose={onClose} />
    </TestErrorBoundary>,
  );
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});

test("session closed keeps the report readable and hides all mutation controls", async () => {
  mockSessionClosed = true;
  renderViewer();
  await waitFor(() => expect(screen.getByText("Keep ")).toBeTruthy());
  expect(screen.getByText("Session closed · read only")).toBeTruthy();
  expect(screen.getByTestId("report-close")).toBeTruthy();
  expect(screen.queryByTestId("report-delete")).toBeNull();
  expect(screen.queryByTestId("report-thread-send-to-chat")).toBeNull();
  fireEvent.press(screen.getByTestId("report-block-para-1"));
  expect(
    screen.getByText(
      "This session is closed. Existing comments remain readable.",
    ),
  ).toBeTruthy();
  expect(screen.queryByTestId("report-comment-input")).toBeNull();
  expect(screen.queryByTestId("delete-comment-comment-1")).toBeNull();
});

test("delete report requires destructive confirmation", async () => {
  renderViewer();
  await waitFor(() => expect(screen.getByTestId("report-delete")).toBeTruthy());
  fireEvent.press(screen.getByTestId("report-delete"));
  expect(screen.getByText("Delete this report?")).toBeTruthy();
  await act(async () =>
    fireEvent.press(screen.getByTestId("report-delete-confirm")),
  );
  expect(mockDeleteReport).toHaveBeenCalledWith(
    "hostc:chat",
    expect.objectContaining({ asset_id: "report-1" }),
  );
});

