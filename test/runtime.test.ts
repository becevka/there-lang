import { describe, expect, test } from 'bun:test';
import {
  ThereElement, StringElement, NumberElement, ListElement, ThereEnv,
} from '../src/runtime/types.ts';

describe('element multiset', () => {
  test('is/not/size/is_not on element', () => {
    const apple = new ThereElement('apple');
    apple.is('red');
    apple.is('red');
    expect(apple.size('red')).toBe(2);
    expect(apple.is_not('red')).toBe(0);
    expect(apple.is_not('blue')).toBe(1);
    apple.not('red');
    expect(apple.size('red')).toBe(1);
  });

  test('size includes self-type per spec', () => {
    const apple = new ThereElement('apple');
    expect(apple.size('apple')).toBe(1);
    apple.is('apple');
    expect(apple.size('apple')).toBe(2);
  });

  test('rest counts non-matching states', () => {
    const e = new ThereElement('e');
    e.is('a'); e.is('a'); e.is('b');
    expect(e.rest('a')).toBe(1);
  });
});

describe('string element', () => {
  test('is concatenates, not removes', () => {
    const s = new StringElement('hello');
    s.is(' world');
    expect(s.value()).toBe('hello world');
    s.not('l');
    expect(s.value()).toBe('heo word');
  });

  test('size counts occurrences', () => {
    const s = new StringElement('hello');
    expect(s.size('l')).toBe(2);
  });

  test('is_not returns 0/1', () => {
    const s = new StringElement('quit');
    expect(s.is_not('quit')).toBe(0);
    expect(s.is_not('go')).toBe(1);
  });
});

describe('number element', () => {
  test('arithmetic via is/not/get/rest/size', () => {
    const n = new NumberElement(8);
    n.is(2);
    expect(n.val).toBe(10);
    n.not(3);
    expect(n.val).toBe(7);
    expect(n.size(2)).toBe(3.5);
    expect(n.rest(2)).toBe(1);
  });

  test('eq compares values', () => {
    expect(new NumberElement(5).eq(5)).toBe(1);
    expect(new NumberElement(5).eq(6)).toBe(0);
  });
});

describe('list element', () => {
  test('push and size', () => {
    const l = new ListElement();
    l.is('a'); l.is('b');
    expect(l.size('')).toBe(2);
  });
});

describe('there env', () => {
  test('set/get properties', () => {
    const t = new ThereEnv();
    const apple = new ThereElement('apple');
    t.set(apple);
    expect(t.get('apple')).toBe(apple);
    expect(t.has('apple')).toBe(1);
    t.remove('apple');
    expect(t.has('apple')).toBe(0);
  });
});
