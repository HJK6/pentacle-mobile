import rules from "../../pentacle-chat-core/tests/fixtures/summary_prose_cases.json";

const compile = (pattern: string) =>
  pattern.startsWith("(?i)")
    ? new RegExp(pattern.slice(4), "i")
    : new RegExp(pattern);
const forbidden = [
  "semicolon",
  "hex",
  "seat",
  "work_id",
  "path",
  "joined_token",
].map((key) => compile(rules.patterns[key as keyof typeof rules.patterns]));
/** Cut-A fallback. The public fixture is the normative regex/abbreviation home. */
export function firstSummarySentence(
  value: string | null | undefined,
): string | null {
  if (!value?.trim()) return null;
  const text = value.trim().replace(/\s+/g, " ");
  let end: number | null = null;
  for (const match of text.matchAll(new RegExp(rules.patterns.terminal, "g"))) {
    const i = match.index!;
    if (
      rules.abbreviations.some((word) =>
        text
          .slice(0, i + 1)
          .toLowerCase()
          .endsWith(word),
      )
    )
      continue;
    end = i + 1;
    break;
  }
  if (end === null) return null;
  const line = text.slice(0, end);
  return line.length <= rules.limit &&
    !forbidden.some((pattern) => pattern.test(line))
    ? line
    : null;
}
