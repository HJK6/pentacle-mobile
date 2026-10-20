// Contracts v1.6 § Assistant identity: the home tab, header and status surface follow the
// operator's assistant name, as Pentacle web does; no product name is hard-coded.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { ASSISTANT_STREAM_ID, DEFAULT_ASSISTANT_NAME, selectAssistantIdentity } from '../src/services/assistantIdentity';

const session = (overrides: Record<string, unknown>) => ({ stream_id: ASSISTANT_STREAM_ID, host: 'hostc', ...overrides }) as any;

test('the assistant stream id defaults to the public id without local config', () => {
  expect(ASSISTANT_STREAM_ID).toBe('home:assistant');
});

test('name follows the assistant session display name, then title, then the default', () => {
  expect(selectAssistantIdentity({ sessions: [session({ display_name: 'Lews', title: 'assistant' })] }))
    .toEqual({ streamId: ASSISTANT_STREAM_ID, name: 'Lews', hostId: 'hostc', sigilKind: 'djinni' });
  expect(selectAssistantIdentity({ sessions: [session({ display_name: '  ', title: 'Nynaeve' })] }).name).toBe('Nynaeve');
  expect(selectAssistantIdentity({ sessions: [session({})] }).name).toBe(DEFAULT_ASSISTANT_NAME);
  expect(selectAssistantIdentity({ sessions: [] })).toEqual({
    streamId: ASSISTANT_STREAM_ID, name: 'Zephyr', hostId: null, sigilKind: 'djinni',
  });
});

test('other sessions never supply the assistant identity', () => {
  const other = { stream_id: 'hostc:claude:one', host: 'hostc', display_name: 'Lews' } as any;
  expect(selectAssistantIdentity({ sessions: [other] }).name).toBe('Zephyr');
});

const ROOT = join(__dirname, '..');
// A private assistant name must not appear in visible text in any case; 'home:assistant' is the
// protocol stream id. The terms are assembled so the public guards do not flag this policy.
const SHORT = 'ba' + 'rt';
const LONG = SHORT + 'imaeus';
const VISIBLE_NAME = new RegExp(`\\b(${SHORT}|${LONG})\\b`, 'i');
const SCANNED = ['app', 'src/components/assistant', 'src/components/status', 'src/components/questions', 'src/components/personal'];


function sources(dir: string): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  return entries.flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|js|jsx)$/.test(name) ? [path] : [];
  });
}

// Every user-visible literal: string and template text plus JSX text, from the parsed source,
// so comments never hide or fake a literal. Test ids and the protocol stream id are exempt.
function visibleLiterals(fileName: string, code: string): string[] {
  const kind = /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : /\.jsx?$/.test(fileName) ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const isTestId = (node: ts.Node) => {
    for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
      if (ts.isJsxAttribute(at)) return at.name.getText(source) === 'testID';
      if (ts.isJsxElement(at) || ts.isJsxSelfClosingElement(at) || ts.isStatement(at)) return false;
    }
    return false;
  };
  const visit = (node: ts.Node) => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && !isTestId(node)) {
      found.push(node.text);
    } else if (ts.isJsxText(node)) {
      found.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found.map((text) => text.replace(/home:assistant/g, ''));
}

test('the literal scan sees through comments and covers string props', () => {
  const offending = visibleLiterals('x.tsx', `<TextInput placeholder="Message // ${SHORT}" testID="assistant-input" />`);
  expect(offending.some((text) => VISIBLE_NAME.test(text))).toBe(true);
  expect(visibleLiterals('x.tsx', `// ${SHORT} only in a comment\nconst id = 'home:assistant';`)
    .some((text) => VISIBLE_NAME.test(text))).toBe(false);
  expect(visibleLiterals('x.tsx', `<View testID="assistant-status-tag" />`)).toEqual([]);
  expect(visibleLiterals('x.tsx', `<Text>ADDED BY ${SHORT.toUpperCase()}</Text>`).some((text) => VISIBLE_NAME.test(text))).toBe(true);
  expect(visibleLiterals('x.tsx', `<Text>${SHORT} is lowercase</Text>`).some((text) => VISIBLE_NAME.test(text))).toBe(true);
  expect(['assistant', '../assistant/ChatsDrawer', '/(tabs)/assistant'].some((text) => VISIBLE_NAME.test(text))).toBe(false);
});

test('no user-visible assistant product-name literal remains in the home surfaces', () => {
  const offenders: string[] = [];
  for (const file of SCANNED.flatMap((dir) => sources(join(ROOT, dir)))) {
    for (const text of visibleLiterals(file, readFileSync(file, 'utf8'))) {
      if (VISIBLE_NAME.test(text)) offenders.push(`${relative(ROOT, file)}: ${text.trim()}`);
    }
  }
  expect(offenders).toEqual([]);
});
