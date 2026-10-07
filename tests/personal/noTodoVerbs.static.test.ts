import * as fs from 'fs';
import * as path from 'path';

// B4: Cosmo `tasks` is the only to-do list. P5 never touches the locked to-do lane
// (`v2_todo_items`, `todo.*` verbs). Static, source-text check over the P5 packet files.
// Deliberately NOT a ban on the word `scope`: response scope drives the ' · PRIVATE' label.
// The outbound-field rule (no scope/priority/due_date/created_by ever sent) is a RUNTIME check
// in the other suites (see support.ts registerOutboundGuard / FakeHousehold.handle).

const ROOT = path.resolve(__dirname, '../..');
const DIRS = ['src/services/household', 'src/components/personal'];
const EXPECTED_FILES = [
  'src/services/household/types.ts',
  'src/services/household/selectors.ts',
  'src/services/household/householdClient.ts',
  'src/services/household/householdStore.ts',
  'src/components/personal/PersonalHome.tsx',
  'src/components/personal/ListsIndex.tsx',
  'src/components/personal/ListDetail.tsx',
  'src/components/personal/CalendarView.tsx',
  'src/components/personal/AddEventSheet.tsx',
];

function sourceFiles(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

describe('P5 packet files', () => {
  it('provide every module and component the interface names', () => {
    const missing = EXPECTED_FILES.filter((f) => !fs.existsSync(path.join(ROOT, f)));
    expect(missing).toEqual([]);
  });

  it('never reference v2_todo or a todo.* verb', () => {
    const files = DIRS.flatMap(sourceFiles);
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const rel of files) {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      if (/v2_todo/i.test(text)) offenders.push(`${rel}: v2_todo`);
      if (/['"`]todo\./.test(text)) offenders.push(`${rel}: todo.* verb string`);
      if (/household\.todo/.test(text)) offenders.push(`${rel}: household.todo verb`);
    }
    expect(offenders).toEqual([]);
  });

  it('only use the six household verbs from the spec', () => {
    const allowed = new Set([
      'household.snapshot',
      'household.item.add',
      'household.item.done',
      'household.item.remove',
      'household.event.add',
      'household.event.remove',
    ]);
    const files = DIRS.flatMap(sourceFiles);
    expect(files.length).toBeGreaterThan(0);
    const unexpected: string[] = [];
    for (const rel of files) {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      for (const match of text.matchAll(/['"`](household\.[a-z_.]+)['"`]/g)) {
        if (!allowed.has(match[1])) unexpected.push(`${rel}: ${match[1]}`);
      }
    }
    expect(unexpected).toEqual([]);
  });
});
