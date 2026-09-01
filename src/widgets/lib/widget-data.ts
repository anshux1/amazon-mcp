export interface ToolEnvelope<T> {
  success: boolean;
  data?: T | null;
  error?: { message?: string };
}

export function unwrap<T>(value: T | ToolEnvelope<T> | null): T | null {
  if (value && typeof value === 'object' && 'success' in value) {
    const envelope = value as ToolEnvelope<T>;
    return envelope.success ? envelope.data ?? null : null;
  }
  return value as T | null;
}

export function errorMessage<T>(value: T | ToolEnvelope<T> | null): string | null {
  if (value && typeof value === 'object' && 'success' in value) {
    const envelope = value as ToolEnvelope<T>;
    return envelope.success ? null : envelope.error?.message ?? 'Request failed';
  }
  return null;
}

export function money(value: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
  }).format(value);
}
