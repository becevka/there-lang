export type TokenType =
  | 'switch'
  | 'string'
  | 'template'
  | 'block'
  | 'sequence'
  | 'list'
  | 'table'
  | 'number'
  | 'resource'
  | 'word';

export interface Token {
  type: TokenType;
  value: string | number;
  raw?: string;
  line: number;
  position: number;
  next?: Token;
  getSequence?: () => Token | undefined;
  parse?: () => Token | undefined;
}

export function makeToken(type: TokenType, value: string | number, line: number, position: number): Token {
  return { type, value, line, position };
}
