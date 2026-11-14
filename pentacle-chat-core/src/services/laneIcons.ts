import table from "../../lane_icons.json";

export type LaneIconKey =
  | "pentacle"
  | "flask"
  | "cube"
  | "phone"
  | "bot"
  | "bug"
  | "truck"
  | "wrench"
  | "columns"
  | "rocket"
  | "hammer"
  | "eye"
  | "camera"
  | "cursor"
  | "home"
  | "book"
  | "chart"
  | "shield"
  | "key"
  | "leaf"
  | "briefcase"
  | "headset"
  | "film"
  | "server";
export const LANE_ICON_KEYS: readonly LaneIconKey[] = table.icons.map(
  (row) => row.key as LaneIconKey,
);
/** The daemon and older clients share this ordered keyword data. Keys without keywords are drawn only when sent. */
export function laneIconFor(title: string): LaneIconKey | null {
  const text = title.toLocaleLowerCase("en-US");
  return (
    (table.icons.find((row) => row.keywords.some((word) => text.includes(word)))
      ?.key as LaneIconKey) ?? null
  );
}
