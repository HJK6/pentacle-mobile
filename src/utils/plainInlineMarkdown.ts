// The one-line chats-list preview shows Markdown as the words it renders to. The
// chat view keeps full Markdown; only this summary line drops the markers. Same
// rule as the web sidebar (pentacle renderer/chat_ui_state.js plainInlineMarkdown)
// so both previews agree.
export function plainInlineMarkdown(text: string): string {
  return String(text || '')
    .split('\n')
    .filter((line) => !/^\s*(```|~~~)[^`]*$/.test(line))
    .map((line) => line.replace(/^\s*(?:(?:#{1,6}|>|[-*+]|\d+[.)])\s+)+/, ''))
    .join(' ')
    // Code spans keep their content verbatim; only the text between them is unmarked.
    .split(/(`+)(.+?)\1(?!`)/)
    .map((part, index) => {
      if (index % 3 === 1) return '';
      if (index % 3 === 2) return part;
      return part
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/g, '$2')
        .replace(/\*(?=\S)([^*]+?)(?<=\S)\*/g, '$1')
        .replace(/(^|[^\w])_(?=\S)([^_]+?)(?<=\S)_(?!\w)/g, '$1$2');
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}
