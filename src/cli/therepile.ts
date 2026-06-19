import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '../parse/parse.ts';
import { defaultParserFacet } from '../facet/defaultFacet.ts';
import type { Token } from '../parse/token.ts';

const NESTED = new Set(['block', 'sequence', 'list', 'table', 'template']);

function printable(tok: Token): string {
  switch (tok.type) {
    case 'string': return JSON.stringify(tok.value);
    case 'template': return '`' + String(tok.value) + '`';
    case 'switch': return ';';
    case 'resource': return '$' + String(tok.value);
    default: return String(tok.value);
  }
}

function printChain(head: Token | undefined, indent: string): void {
  let cur = head;
  while (cur) {
    const label = `${cur.type}@${cur.line}:${cur.position} ${printable(cur)}`;
    process.stdout.write(indent + label + '\n');
    if (NESTED.has(cur.type)) {
      const inner = cur.type === 'template' ? cur.parse?.() : cur.getSequence?.();
      if (inner) printChain(inner, indent + '  ');
    }
    cur = cur.next;
  }
}

export async function therepile(path: string): Promise<void> {
  const abs = resolve(path);
  const source = readFileSync(abs, 'utf8');
  const parsed = parse(source, defaultParserFacet);

  if (parsed.inline.aliases && Object.keys(parsed.inline.aliases).length) {
    process.stdout.write('# inline aliases\n');
    for (const [k, v] of Object.entries(parsed.inline.aliases)) {
      process.stdout.write(`  ${JSON.stringify(k)} -> ${JSON.stringify(v)}\n`);
    }
  }
  if (parsed.inline.phrases.length) {
    process.stdout.write('# inline phrases\n');
    for (const p of parsed.inline.phrases) {
      process.stdout.write(`  ${JSON.stringify(p.pattern)} -> ${JSON.stringify(p.replacement)}\n`);
    }
  }
  if (parsed.inline.resources.length) {
    process.stdout.write('# inline resources\n');
    for (const r of parsed.inline.resources) {
      process.stdout.write(`  $${r.name}(${r.paramNames.join(' ')})\n`);
    }
  }
  if (parsed.resources.length) {
    process.stdout.write(`# top-level resource references: ${parsed.resources.map((r) => '$' + r).join(' ')}\n`);
  }
  process.stdout.write('# tokens\n');
  printChain(parsed.head, '');
}
