import { readFileSync, existsSync, appendFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as readline from 'node:readline';
import { parse } from '../parse/parse.ts';
import { Evaluator, unwrapSeq } from '../eval/evaluator.ts';
import { buildDefaultFacet, defaultParserFacet } from '../facet/defaultFacet.ts';
import { applyInlineFacet } from '../facet/inlineHost.ts';
import { installModuleLoader } from '../facet/modules.ts';
import {
  ThereEnv, EnvElement, NumberElement, StringElement, ThereElement, ListElement, VectorElement, TableElement,
} from '../runtime/types.ts';

// ── shared helpers ───────────────────────────────────────────────────────────

function wireThere(there: ThereEnv, ask: ThereEnv['ask']): void {
  there.out = (text, flag) => {
    if (flag === 1) process.stdout.write(`\x1b[31m${text}\x1b[0m\n`);
    else process.stdout.write(text + '\n');
  };
  there.ask = ask;
}

/** SPEC § 2: a directory loads its `index.th`; a bare name gets `.th`. */
function resolveProgramPath(path: string): string {
  let p = resolve(path);
  if (existsSync(p) && statSync(p).isDirectory()) return join(p, 'index.th');
  if (!existsSync(p) && existsSync(`${p}.th`)) return `${p}.th`;
  return p;
}

// ── file mode: piped/sequential stdin via a custom line reader ───────────────

interface LineReader {
  ask(prompt: string, cb: (line: string) => void): void;
  close(): void;
}

function makeLineReader(): LineReader {
  const lineQueue: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  let buffer = '';
  let ended = false;

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string | Buffer) => {
    buffer += chunk.toString();
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (waiters.length > 0) waiters.shift()!(line);
      else lineQueue.push(line);
      idx = buffer.indexOf('\n');
    }
  });
  process.stdin.on('end', () => {
    ended = true;
    while (waiters.length > 0) waiters.shift()!('');
  });

  return {
    ask(prompt, cb) {
      process.stdout.write(prompt);
      if (lineQueue.length > 0) cb(lineQueue.shift()!);
      else if (ended) cb('');
      else waiters.push(cb);
    },
    close() { process.stdin.pause(); },
  };
}

async function runFile(path: string): Promise<void> {
  const filePath = resolveProgramPath(path);
  const source = readFileSync(filePath, 'utf8');
  const parsed = parse(source, defaultParserFacet);

  const lr = makeLineReader();
  const there = new ThereEnv();
  wireThere(there, (text, cb) => lr.ask(text, cb));
  applyInlineFacet(there, parsed.inline);

  const ev = new Evaluator(there, buildDefaultFacet());
  ev.baseDir = dirname(filePath);
  installModuleLoader(ev);
  try {
    await ev.run(parsed.head, parsed.resources);
  } catch (err) {
    there.out(`error: ${(err as Error).message}`, 1);
  }
  lr.close();
}

// ── repl mode: readline with history, multi-line, commands ───────────────────

const HISTORY_FILE = resolve(process.cwd(), '.history');

function loadHistory(): string[] {
  if (!existsSync(HISTORY_FILE)) return [];
  return readFileSync(HISTORY_FILE, 'utf8').split('\n').filter((l) => l.length > 0);
}

function appendHistory(line: string): void {
  try { appendFileSync(HISTORY_FILE, line + '\n'); } catch { /* ignore */ }
}

function formatResult(v: unknown): string | null {
  const x = unwrapSeq(v);
  if (x == null) return null;
  if (x instanceof ThereEnv) return null;
  if (x instanceof NumberElement) return String(x.val);
  if (x instanceof StringElement) return JSON.stringify(x.val);
  if (x instanceof VectorElement) return `[vector ${x.type}]`;
  if (x instanceof ListElement) {
    return `[${x.states.map((s) => formatResult(s) ?? '?').join(' ')}]`;
  }
  if (x instanceof TableElement) return formatTable(x);
  if (x instanceof ThereElement) {
    return x.states.length === 0 ? x.type : `${x.type} {${x.states.join(',')}}`;
  }
  if (x instanceof EnvElement) return null;
  if (Array.isArray(x)) return `[${x.map((v) => formatResult(v) ?? '?').join(' ')}]`;
  if (typeof x === 'number' || typeof x === 'string' || typeof x === 'boolean') return String(x);
  if (typeof x === 'object' && x && '_ft' in (x as Record<string, unknown>)) return null;
  return String(x);
}

function formatTable(t: TableElement): string {
  const cells: string[][] = [];
  cells.push(t.columns);
  for (let i = 0; i < t.count; i += 1) {
    cells.push(t.columns.map((c) => formatResult(t.struct[c]![i]) ?? ''));
  }
  const widths = t.columns.map((_, j) => Math.max(...cells.map((row) => row[j]!.length)));
  const fmt = (row: string[]) => row.map((c, j) => c.padEnd(widths[j]!)).join(' | ');
  const sep = widths.map((w) => '-'.repeat(w)).join('-+-');
  const lines = [fmt(cells[0]!), sep, ...cells.slice(1).map(fmt)];
  return `|${t.columns.join(' ')}| (${t.count})\n${lines.join('\n')}`;
}

function isComplete(src: string): boolean {
  let depth = 0;
  let inString: string | null = null;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (inString) {
      if (ch === '\\' && i + 1 < src.length) { i += 1; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { inString = ch; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') depth -= 1;
  }
  return inString == null && depth <= 0;
}

function printHelp(): void {
  const lines = [
    'REPL commands:',
    '  help      \\?   show this message',
    '  clear     \\c   reset the environment',
    '  silence   \\s   toggle result printing',
    '  exit      \\q   leave the REPL',
    '',
    'Multi-line input is supported — open delimiters keep the prompt going.',
  ];
  for (const l of lines) process.stdout.write(l + '\n');
}

async function startRepl(): Promise<void> {
  let silent = false;
  let buffer = '';
  const primary = 'there> ';
  const secondary = '  ...> ';

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    history: loadHistory().reverse(),
    historySize: 1000,
    prompt: primary,
  });

  const ask: ThereEnv['ask'] = (text, cb) => { rl.question(text, cb); };
  let there = new ThereEnv();
  let ev = buildReplEvaluator(there, ask);

  process.stdout.write('there REPL — type help or \\? for commands, exit or \\q to leave.\n');
  rl.prompt();

  let queue: Promise<void> = Promise.resolve();
  const handle = async (raw: string): Promise<void> => {
    const line = raw.replace(/\r$/, '');
    const trimmed = line.trim();

    if (buffer === '') {
      switch (trimmed) {
        case 'help': case '\\?': printHelp(); rl.prompt(); return;
        case 'exit': case '\\q': rl.close(); return;
        case 'clear': case '\\c':
          there = new ThereEnv();
          ev = buildReplEvaluator(there, ask);
          process.stdout.write('environment cleared.\n');
          rl.prompt();
          return;
        case 'silence': case '\\s':
          silent = !silent;
          process.stdout.write(`result printing ${silent ? 'off' : 'on'}.\n`);
          rl.prompt();
          return;
      }
    }

    buffer = buffer ? buffer + '\n' + line : line;
    if (!isComplete(buffer)) {
      rl.setPrompt(secondary);
      rl.prompt();
      return;
    }

    const src = buffer;
    buffer = '';
    rl.setPrompt(primary);
    if (src.trim().length > 0) appendHistory(src.replace(/\n/g, ' '));

    try {
      const parsed = parse(src, defaultParserFacet);
      const result = await ev.run(parsed.head, parsed.resources);
      if (!silent) {
        const formatted = formatResult(result);
        if (formatted !== null) process.stdout.write(formatted + '\n');
      }
    } catch (err) {
      process.stdout.write(`\x1b[31m${(err as Error).message}\x1b[0m\n`);
    }
    rl.prompt();
  };

  rl.on('line', (raw) => {
    queue = queue.then(() => handle(raw)).catch((err) => {
      process.stdout.write(`\x1b[31m${(err as Error).message}\x1b[0m\n`);
    });
  });

  rl.on('close', () => {
    queue.finally(() => {
      process.stdout.write('\n');
      process.exit(0);
    });
  });
}

function buildReplEvaluator(there: ThereEnv, ask: ThereEnv['ask']): Evaluator {
  wireThere(there, ask);
  there.modes['auto-read'] = true;
  const ev = new Evaluator(there, buildDefaultFacet());
  ev.baseDir = process.cwd();
  installModuleLoader(ev);
  return ev;
}

// ── entry ────────────────────────────────────────────────────────────────────

const arg = process.argv[2];
if (!arg) {
  await startRepl();
} else if (arg === '--ast' || arg === '--pile') {
  const target = process.argv[3];
  if (!target) {
    process.stderr.write('Usage: there --ast <file.th>\n');
    process.exit(1);
  }
  const { therepile } = await import('./therepile.ts');
  await therepile(target);
} else if (arg === '--where' || arg === '--test') {
  const target = process.argv[3];
  if (!target) {
    process.stderr.write('Usage: there --where <test.th | dir>\n');
    process.exit(1);
  }
  const { runWhere } = await import('./where.ts');
  const lr = makeLineReader();
  const { failures } = await runWhere(target, {
    out: (text, flag) => {
      if (flag === 1) process.stdout.write(`\x1b[31m${text}\x1b[0m\n`);
      else process.stdout.write(text + '\n');
    },
    ask: (text, cb) => lr.ask(text, cb),
  });
  lr.close();
  process.exit(failures > 0 ? 1 : 0);
} else {
  await runFile(arg);
}
