import type { Token } from './token.ts';
import { tokenize } from './tokenize.ts';
import { applyPhrases, type Phrase } from './phrases.ts';
import { extractInlineFacet, type InlineFacet, type RawPhrase } from './inlineFacet.ts';

export interface ParserFacet {
  aliases: Record<string, string>;
  phrases: RawPhrase[];
}

export interface ParseResult {
  head: Token | undefined;
  resources: string[];
  inline: InlineFacet;
}

function compilePhrases(raw: RawPhrase[], aliases: Record<string, string>): Phrase[] {
  return raw.map(({ pattern, replacement }) => ({
    pattern: tokensOf(pattern, aliases),
    rawReplacement: replacement,
  }));
}

function tokensOf(src: string, aliases: Record<string, string>): Token[] {
  const { head } = tokenize(src, aliases);
  const out: Token[] = [];
  let cur = head;
  while (cur) {
    out.push(cur);
    cur = cur.next;
  }
  return out;
}

function attachLazyParsers(head: Token | undefined, blockFacet: CompiledFacet, allResources: string[]): void {
  // Per practical use (natural.th's `($1 is? healthy)` replacement), sequences
  // and tables need single-token aliases applied to their bodies, otherwise
  // operator words like `is?` never get rewritten to `?`. Phrases stay off in
  // them so a replacement that produces a sequence can't re-trigger itself.
  const seqFacet: CompiledFacet = { aliases: blockFacet.aliases, phrases: [] };
  let cur = head;
  while (cur) {
    if (cur.type === 'block' || cur.type === 'list') {
      const body = String(cur.raw ?? cur.value);
      cur.getSequence = () => parseInner(body, blockFacet, allResources);
    } else if (cur.type === 'sequence' || cur.type === 'table') {
      const body = String(cur.raw ?? cur.value);
      cur.getSequence = () => parseInner(body, seqFacet, allResources);
    } else if (cur.type === 'template') {
      const body = String(cur.raw ?? cur.value);
      cur.parse = () => parseInner(body, { aliases: {}, phrases: [] }, allResources);
    }
    cur = cur.next;
  }
}

interface CompiledFacet {
  aliases: Record<string, string>;
  phrases: Phrase[];
}

function parseInner(source: string, facet: CompiledFacet, allResources: string[]): Token | undefined {
  const { head, resources } = tokenize(source, facet.aliases);
  for (const r of resources) if (!allResources.includes(r)) allResources.push(r);
  const phrased = applyPhrases(head, facet.phrases, facet.aliases, allResources);
  attachLazyParsers(phrased, facet, allResources);
  return phrased;
}

export function parse(source: string, facet: ParserFacet): ParseResult {
  const { stripped, inline } = extractInlineFacet(source);

  const mergedAliases: Record<string, string> = { ...facet.aliases, ...inline.aliases };
  const mergedRawPhrases: RawPhrase[] = [...facet.phrases, ...inline.phrases];
  const phrases = compilePhrases(mergedRawPhrases, mergedAliases);

  const compiled: CompiledFacet = { aliases: mergedAliases, phrases };
  const allResources: string[] = [];

  const { head, resources } = tokenize(stripped, mergedAliases);
  for (const r of resources) if (!allResources.includes(r)) allResources.push(r);

  const phrased = applyPhrases(head, phrases, mergedAliases, allResources);
  attachLazyParsers(phrased, compiled, allResources);

  return { head: phrased, resources: allResources, inline };
}
