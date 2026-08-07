import { describe, expect, it } from 'vitest';
import { formatScore, humanAge, padEndVisible, snippet } from './format.js';

const NOW = 1_700_000_000_000;

describe('humanAge', () => {
  it('formats sub-minute, minutes, hours, days, years', () => {
    expect(humanAge(NOW, NOW)).toBe('now');
    expect(humanAge(NOW - 5 * 60_000, NOW)).toBe('5m');
    expect(humanAge(NOW - 3 * 3_600_000, NOW)).toBe('3h');
    expect(humanAge(NOW - 4 * 86_400_000, NOW)).toBe('4d');
    expect(humanAge(NOW - 800 * 86_400_000, NOW)).toBe('2y');
  });

  it('never returns a negative age for future timestamps', () => {
    expect(humanAge(NOW + 10_000, NOW)).toBe('now');
  });
});

describe('snippet', () => {
  it('collapses whitespace and clips with an ellipsis', () => {
    expect(snippet('a\n  b\t c')).toBe('a b c');
    expect(snippet('x'.repeat(100), 10)).toHaveLength(10);
    expect(snippet('x'.repeat(100), 10).endsWith('…')).toBe(true);
  });
});

describe('padEndVisible', () => {
  it('pads short strings and leaves long ones untouched', () => {
    expect(padEndVisible('ab', 5)).toBe('ab   ');
    expect(padEndVisible('abcdef', 3)).toBe('abcdef');
  });
});

describe('formatScore (small real scores must not flatten to 0.00)', () => {
  it('renders three significant figures across magnitudes', () => {
    expect(formatScore(0.013245)).toBe('0.0132');
    expect(formatScore(0.0041537)).toBe('0.00415');
    expect(formatScore(0.5)).toBe('0.5');
    expect(formatScore(12.345)).toBe('12.3');
    expect(formatScore(1)).toBe('1');
  });

  it('NEVER renders a flat 0.00 for a nonzero score', () => {
    for (const s of [0.004, 0.0001, 1.23e-7, 0.0049999, 0.00001234]) {
      const rendered = formatScore(s);
      expect(rendered, `score ${s}`).not.toBe('0.00');
      expect(rendered, `score ${s}`).not.toBe('0');
      expect(Number(rendered), `score ${s}`).toBeGreaterThan(0);
    }
  });

  it('preserves relative order for scores that differ at three significant figures', () => {
    const scores = [0.9, 0.104, 0.0132, 0.00415, 0.000073];
    const rendered = scores.map((s) => Number(formatScore(s)));
    for (let i = 1; i < rendered.length; i++) {
      expect(rendered[i - 1]).toBeGreaterThan(rendered[i] as number);
    }
  });

  it('handles zero and non-finite values without inventing precision', () => {
    expect(formatScore(0)).toBe('0');
    expect(formatScore(Number.NaN)).toBe('NaN');
    expect(formatScore(Number.POSITIVE_INFINITY)).toBe('Infinity');
  });
});
