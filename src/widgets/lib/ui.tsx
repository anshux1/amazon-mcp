'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { useTheme, useWidgetSDK } from '@nitrostack/widgets';

/* ------------------------------------------------------------------ data */

export interface ToolEnvelope<T> {
  success: boolean;
  data?: T | null;
  error?: { code?: string; message?: string };
}

export function unwrap<T>(value: T | ToolEnvelope<T> | null): T | null {
  if (value && typeof value === 'object' && 'success' in value) {
    const envelope = value as ToolEnvelope<T>;
    return envelope.success ? envelope.data ?? null : null;
  }
  return (value as T | null) ?? null;
}

export function errorOf<T>(value: T | ToolEnvelope<T> | null): { code?: string; message: string } | null {
  if (value && typeof value === 'object' && 'success' in value) {
    const envelope = value as ToolEnvelope<T>;
    if (!envelope.success) {
      return { code: envelope.error?.code, message: envelope.error?.message ?? 'Request failed' };
    }
  }
  return null;
}

export function money(value: number | null | undefined, currency: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value);
  } catch {
    // An unexpected currency code must not blank out the whole widget.
    return `${value.toFixed(2)} ${currency}`;
  }
}

export function timeAgo(iso?: string): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const seconds = Math.round((Date.now() - then) / 1000);
  const units: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [60, 'second'],
    [3600, 'minute'],
    [86400, 'hour'],
    [2592000, 'day'],
  ];
  try {
    const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    if (seconds < 60) return format.format(-seconds, 'second');
    if (seconds < 3600) return format.format(-Math.round(seconds / 60), 'minute');
    if (seconds < 86400) return format.format(-Math.round(seconds / 3600), 'hour');
    return format.format(-Math.round(seconds / 86400), 'day');
  } catch {
    void units;
    return new Date(then).toLocaleString();
  }
}

export function expiresIn(iso?: string): string {
  if (!iso) return '';
  const remaining = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if (Number.isNaN(remaining)) return '';
  if (remaining <= 0) return 'expired';
  if (remaining < 60) return `${remaining}s left`;
  return `${Math.round(remaining / 60)} min left`;
}

/* --------------------------------------------------------------- actions */

export interface ToolActionState {
  /** Key of the action currently awaiting a confirmation click. */
  confirming: string | null;
  /** Key of the action currently in flight. */
  pending: string | null;
  error: string | null;
  success: string | null;
}

/**
 * Runs MCP tool calls from a widget with the interaction rules a shopping
 * surface needs: a mutating call asks for confirmation first, only one call is
 * ever in flight, and a failure is shown in the widget instead of vanishing.
 *
 * A tool call travels through the host, which attaches the user's
 * authorization. If the host does not, the server answers UNAUTHORIZED and
 * that message is surfaced here rather than silently doing nothing.
 */
export function useToolActions() {
  const { callTool, sendFollowUpMessage } = useWidgetSDK();
  const [state, setState] = useState<ToolActionState>({
    confirming: null,
    pending: null,
    error: null,
    success: null,
  });

  const reset = useCallback(() => {
    setState({ confirming: null, pending: null, error: null, success: null });
  }, []);

  const ask = useCallback((key: string) => {
    setState((current) => ({ ...current, confirming: key, error: null, success: null }));
  }, []);

  const cancel = useCallback(() => {
    setState((current) => ({ ...current, confirming: null }));
  }, []);

  const run = useCallback(
    async (
      key: string,
      tool: string,
      args: Record<string, unknown> = {},
      options: { successMessage?: string; followUp?: string } = {},
    ) => {
      setState({ confirming: null, pending: key, error: null, success: null });
      try {
        const response = (await callTool(tool, args)) as unknown;
        const failure = readCallFailure(response);
        if (failure) {
          setState({ confirming: null, pending: null, error: failure, success: null });
          return;
        }
        setState({
          confirming: null,
          pending: null,
          error: null,
          success: options.successMessage ?? null,
        });
        if (options.followUp) {
          await sendFollowUpMessage(options.followUp).catch(() => undefined);
        }
      } catch (error) {
        setState({
          confirming: null,
          pending: null,
          error: error instanceof Error ? error.message : 'That action could not be completed.',
          success: null,
        });
      }
    },
    [callTool, sendFollowUpMessage],
  );

  const say = useCallback(
    async (prompt: string) => {
      await sendFollowUpMessage(prompt).catch(() => undefined);
    },
    [sendFollowUpMessage],
  );

  return { ...state, ask, cancel, reset, run, say };
}

/** Pulls the server's own error envelope out of a host callTool response. */
function readCallFailure(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null;
  const record = response as Record<string, unknown>;

  const structured = record.structuredContent ?? record.content ?? record;
  const payload = Array.isArray(structured)
    ? readFirstJson(structured as unknown[])
    : (structured as Record<string, unknown> | null);

  if (payload && typeof payload === 'object' && payload.success === false) {
    const error = payload.error as { message?: string } | undefined;
    return error?.message ?? 'That action could not be completed.';
  }
  if (record.isError === true) {
    return 'That action could not be completed.';
  }
  return null;
}

function readFirstJson(entries: unknown[]): Record<string, unknown> | null {
  for (const entry of entries) {
    const record = entry as { type?: string; text?: string };
    if (record?.type === 'text' && typeof record.text === 'string') {
      try {
        return JSON.parse(record.text) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------ components */

export function useCardClass(): string {
  const theme = useTheme();
  return `card ${theme === 'dark' ? 'dark' : ''}`;
}

export function Card({ children }: { children: ReactNode }) {
  return <section className={useCardClass()}>{children}</section>;
}

export function Loading({ label }: { label: string }) {
  return (
    <Card>
      <div className="stack">
        <div className="row">
          <span className="spinner" style={{ color: 'var(--text-faint)' }} />
          <span className="muted">{label}</span>
        </div>
        <div className="skeleton" style={{ height: 14, width: '60%' }} />
        <div className="skeleton" style={{ height: 62 }} />
        <div className="skeleton" style={{ height: 62 }} />
      </div>
    </Card>
  );
}

export function Failure({ error, onRetry }: { error: { code?: string; message: string }; onRetry?: () => void }) {
  const hint = errorHint(error.code);
  return (
    <Card>
      <div className="stack">
        <p className="eyebrow">Something went wrong</p>
        <div className="notice notice-error">
          <span aria-hidden>⚠</span>
          <span>{error.message}</span>
        </div>
        {hint && <p className="muted">{hint}</p>}
        {onRetry && (
          <button type="button" className="btn btn-secondary" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    </Card>
  );
}

function errorHint(code?: string): string | null {
  switch (code) {
    case 'UNAUTHORIZED':
      return 'Sign in again, then ask the assistant to retry.';
    case 'FORBIDDEN':
      return 'This account is missing the shopping permission for that action.';
    case 'CONFLICT':
      return 'The cart or the price changed. Ask the assistant to run checkout again.';
    case 'OUT_OF_STOCK':
      return 'Try a smaller quantity, or ask for an alternative.';
    case 'RATE_LIMITED':
      return 'The daily catalog budget is exhausted. Try again later.';
    case 'EXTERNAL_SERVICE_ERROR':
      return 'eBay did not respond. Ask the assistant to retry in a moment.';
    default:
      return null;
  }
}

export function Empty({ mark, title, hint }: { mark: string; title: string; hint?: string }) {
  return (
    <Card>
      <div className="empty">
        <div className="empty-mark" aria-hidden>{mark}</div>
        <p className="title">{title}</p>
        {hint && <p className="muted">{hint}</p>}
      </div>
    </Card>
  );
}

export function ActionFeedback({ error, success }: { error: string | null; success: string | null }) {
  if (error) {
    return (
      <div className="notice notice-error">
        <span aria-hidden>⚠</span>
        <span>{error}</span>
      </div>
    );
  }
  if (success) {
    return (
      <div className="notice notice-success">
        <span aria-hidden>✓</span>
        <span>{success}</span>
      </div>
    );
  }
  return null;
}

/**
 * A button that asks for a second click before it mutates anything.
 *
 * Cart and order tools change server state and, for an order, spend money, so
 * the widget never fires one straight from a single click.
 */
export function ConfirmButton({
  actionKey,
  actions,
  label,
  confirmLabel,
  question,
  onConfirm,
  variant = 'primary',
  small,
  block,
  disabled,
}: {
  actionKey: string;
  actions: ReturnType<typeof useToolActions>;
  label: string;
  confirmLabel: string;
  question: string;
  onConfirm: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  small?: boolean;
  block?: boolean;
  disabled?: boolean;
}) {
  const busy = actions.pending === actionKey;
  const otherBusy = actions.pending !== null && !busy;
  const className = [
    'btn',
    variant === 'secondary' ? 'btn-secondary' : variant === 'danger' ? 'btn-danger' : '',
    small ? 'btn-sm' : '',
    block ? 'btn-block' : '',
  ]
    .filter(Boolean)
    .join(' ');

  if (actions.confirming === actionKey) {
    return (
      <div className="confirm">
        <span className="grow">{question}</span>
        <button type="button" className={`btn ${small ? 'btn-sm' : ''}`} onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button type="button" className={`btn btn-ghost ${small ? 'btn-sm' : ''}`} onClick={actions.cancel}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      className={className}
      disabled={disabled || busy || otherBusy}
      onClick={() => actions.ask(actionKey)}
    >
      {busy && <span className="spinner" />}
      {busy ? 'Working…' : label}
    </button>
  );
}

/** A non-mutating call (a read, or a chat follow-up) needs no confirmation. */
export function ActionButton({
  actionKey,
  actions,
  label,
  onClick,
  variant = 'secondary',
  small,
  block,
  disabled,
}: {
  actionKey: string;
  actions: ReturnType<typeof useToolActions>;
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'ghost';
  small?: boolean;
  block?: boolean;
  disabled?: boolean;
}) {
  const busy = actions.pending === actionKey;
  const otherBusy = actions.pending !== null && !busy;
  const className = [
    'btn',
    variant === 'secondary' ? 'btn-secondary' : variant === 'ghost' ? 'btn-ghost' : '',
    small ? 'btn-sm' : '',
    block ? 'btn-block' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button type="button" className={className} disabled={disabled || busy || otherBusy} onClick={onClick}>
      {busy && <span className="spinner" />}
      {busy ? 'Working…' : label}
    </button>
  );
}

export function Stepper({
  value,
  min = 1,
  max = 99,
  disabled,
  onChange,
}: {
  value: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  onChange: (next: number) => void;
}) {
  return (
    <div className="stepper">
      <button type="button" aria-label="Decrease" disabled={disabled || value <= min} onClick={() => onChange(value - 1)}>
        −
      </button>
      <span className="value" aria-live="polite">{value}</span>
      <button type="button" aria-label="Increase" disabled={disabled || value >= max} onClick={() => onChange(value + 1)}>
        +
      </button>
    </div>
  );
}

/** An image that removes itself if the eBay CDN URL does not resolve. */
export function Thumb({ src, alt, size = 56 }: { src?: string; alt: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) {
    return (
      <div
        className="thumb"
        style={{ width: size, height: size, display: 'grid', placeItems: 'center', fontSize: size / 3 }}
        aria-hidden
      >
        🛍
      </div>
    );
  }
  return (
    <img
      className="thumb"
      src={src}
      alt={alt}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setBroken(true)}
    />
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'placed' ? 'badge-success' : status === 'cancelled' ? 'badge-danger' : 'badge';
  return (
    <span className={`badge ${tone}`}>
      <span className="dot" aria-hidden />
      {status}
    </span>
  );
}

export function AvailabilityBadge({ quantity }: { quantity?: number | null }) {
  if (quantity === null || quantity === undefined) {
    return <span className="badge">Availability at checkout</span>;
  }
  if (quantity <= 0) return <span className="badge badge-danger">Out of stock</span>;
  if (quantity <= 5) return <span className="badge badge-warning">Only {quantity} left</span>;
  return <span className="badge badge-success">{quantity} available</span>;
}
