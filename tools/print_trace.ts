#!/usr/bin/env -S npx tsx
// print_trace.ts — render a TraceContract as a markdown table for PR descriptions.
//
// Usage:
//   npx tsx tools/print_trace.ts <trace-name>        # print one trace
//   npx tsx tools/print_trace.ts --list              # list available trace names
//   npx tsx tools/print_trace.ts --all               # print every trace
//   ./tools/print_trace.ts <trace-name>              # equivalent when executable
//
// The output is markdown-rendered (one ## heading + one table per trace).

import { TRACE_INVENTORY } from '../tests/contracts/traces';
import type { TraceContract, TraceStep } from '../tests/contracts/traces/types';
import { isNegativeStep } from '../tests/contracts/traces/types';

function describeStep(step: TraceStep): { actor: string; name: string; t: string; label: string } {
  if (isNegativeStep(step)) {
    const target = step.not;
    const targetName =
      target.actor === 'user'
        ? target.action
        : target.actor === 'daemon'
          ? target.event
          : target.effect;
    const window =
      step.within_steps != null
        ? `${step.within_steps} steps`
        : step.within_ms != null
          ? `${step.within_ms}ms`
          : 'unbounded';
    return {
      actor: `NOT(${target.actor})`,
      name: targetName,
      t: window,
      label: step.assertLabel ?? '',
    };
  }
  const stepAny = step as { t?: string; assertLabel?: string };
  switch (step.actor) {
    case 'user':
      return { actor: 'user', name: step.action, t: stepAny.t ?? '—', label: stepAny.assertLabel ?? '' };
    case 'daemon': {
      const dn = step.synthetic ? `${step.event} (SYNTHETIC)` : step.event;
      return { actor: 'daemon', name: dn, t: stepAny.t ?? '—', label: stepAny.assertLabel ?? '' };
    }
    case 'reducer':
    case 'screen':
    case 'composer':
      return {
        actor: step.actor,
        name: step.effect,
        t: stepAny.t ?? '—',
        label: stepAny.assertLabel ?? '',
      };
  }
}

function renderTrace(trace: TraceContract): string {
  const lines: string[] = [];
  lines.push(`## Trace: \`${trace.name}\``);
  lines.push('');
  lines.push(`**Fixture:** \`tests/contracts/fixtures/${trace.fixture}.jsonl\``);
  lines.push('');
  lines.push(`**Description:** ${trace.description}`);
  lines.push('');
  lines.push('| # | actor | action / event / effect | t | label |');
  lines.push('| ---: | --- | --- | --- | --- |');
  trace.steps.forEach((step, i) => {
    const d = describeStep(step);
    lines.push(`| ${i} | ${d.actor} | \`${d.name}\` | ${d.t} | ${d.label.replace(/\|/g, '\\|')} |`);
  });
  return lines.join('\n');
}

function listNames(): string {
  return Object.keys(TRACE_INVENTORY).sort().join('\n');
}

function main() {
  const arg = process.argv[2];
  if (!arg || arg === '--help' || arg === '-h') {
    process.stdout.write(
      [
        'usage:',
        '  npx tsx tools/print_trace.ts <trace-name>   print the named trace as a markdown table',
        '  npx tsx tools/print_trace.ts --list         list available trace names',
        '  npx tsx tools/print_trace.ts --all          print every trace',
        '  ./tools/print_trace.ts <trace-name>         equivalent when executable',
        '',
        'available traces:',
        listNames(),
        '',
      ].join('\n'),
    );
    process.exit(arg ? 0 : 2);
    return;
  }

  if (arg === '--list') {
    process.stdout.write(listNames() + '\n');
    return;
  }

  if (arg === '--all') {
    const blocks: string[] = [];
    for (const name of Object.keys(TRACE_INVENTORY).sort()) {
      blocks.push(renderTrace(TRACE_INVENTORY[name]));
    }
    process.stdout.write(blocks.join('\n\n') + '\n');
    return;
  }

  const trace = TRACE_INVENTORY[arg];
  if (!trace) {
    process.stderr.write(`unknown trace: ${arg}\n`);
    process.stderr.write('available traces:\n' + listNames() + '\n');
    process.exit(1);
    return;
  }

  process.stdout.write(renderTrace(trace) + '\n');
}

main();
