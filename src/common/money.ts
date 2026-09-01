import type { Money } from './types.js';

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function parseMoney(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? roundMoney(parsed) : fallback;
}

export function addMoney(values: number[]): number {
  return roundMoney(values.reduce((total, value) => total + value, 0));
}

export function formatMoney(value: number, currency: string): Money {
  return { value: roundMoney(value), currency };
}
