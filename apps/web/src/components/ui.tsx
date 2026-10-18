/** Reusable presentational primitives (panels, sliders, toggles, modal). */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { readStoredBoolean, writeStoredBoolean } from "../lib/uiPrefs";
import { clamp } from "../lib/utils";

// ── Collapsible section ───────────────────────────────────────────────────

export interface SectionProps {
  title: string;
  icon?: string;
  note?: string;
  defaultOpen?: boolean;
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
  className?: string;
}

export function Section({
  title,
  icon,
  note,
  defaultOpen = true,
  actions,
  children,
  testId,
  className,
}: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`section ${open ? "is-open" : ""} ${className ?? ""}`} data-testid={testId}>
      <header className="section-head">
        <button
          type="button"
          className="section-toggle"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <span className="section-chevron" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          {icon ? <span className="section-icon" aria-hidden="true">{icon}</span> : null}
          <span className="section-title">{title}</span>
        </button>
        {actions ? <div className="section-actions">{actions}</div> : null}
      </header>
      {open ? (
        <div className="section-body">
          {note ? <p className="section-note">{note}</p> : null}
          {children}
        </div>
      ) : null}
    </section>
  );
}

// ── Collapsible top-level group (sticky header + persisted state) ─────────

export interface CollapsibleGroupProps {
  title: string;
  icon?: string;
  storageKey: string;
  defaultOpen?: boolean;
  summary?: ReactNode;
  children: ReactNode;
  testId?: string;
  className?: string;
}

export function CollapsibleGroup({
  title,
  icon,
  storageKey,
  defaultOpen = true,
  summary,
  children,
  testId,
  className,
}: CollapsibleGroupProps) {
  const [open, setOpen] = useState(() => readStoredBoolean(storageKey, defaultOpen));
  const toggle = () => {
    setOpen((previous) => {
      writeStoredBoolean(storageKey, !previous);
      return !previous;
    });
  };
  return (
    <section
      className={`panel-group ${open ? "is-open" : ""} ${className ?? ""}`}
      data-testid={testId}
    >
      <button
        type="button"
        className="panel-group-head"
        aria-expanded={open}
        onClick={toggle}
      >
        <span className="panel-group-chevron" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        {icon ? (
          <span className="panel-group-icon" aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <span className="panel-group-title">{title}</span>
        {summary ? <span className="panel-group-summary">{summary}</span> : null}
      </button>
      {open ? <div className="panel-group-body">{children}</div> : null}
    </section>
  );
}

// ── Slider ────────────────────────────────────────────────────────────────

export interface SliderFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  decimals?: number;
  unit?: string;
  hint?: string;
  disabled?: boolean;
  testId?: string;
  format?: (value: number) => string;
  onBegin: () => void;
  onLive: (value: number) => void;
  onEnd: (changed: boolean) => void;
}

export function SliderField({
  label,
  value,
  min,
  max,
  step,
  decimals = 2,
  unit = "",
  hint,
  disabled,
  testId,
  format,
  onBegin,
  onLive,
  onEnd,
}: SliderFieldProps) {
  const [active, setActive] = useState(false);
  const activeRef = useRef(false);
  const changedRef = useRef(false);

  const begin = useCallback(() => {
    if (activeRef.current) return;
    activeRef.current = true;
    changedRef.current = false;
    setActive(true);
    onBegin();
  }, [onBegin]);

  const finish = useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    setActive(false);
    const changed = changedRef.current;
    changedRef.current = false;
    onEnd(changed);
  }, [onEnd]);

  const display = format ? format(value) : `${value.toFixed(decimals)}${unit}`;

  return (
    <div className={`slider-field ${active ? "is-active" : ""} ${disabled ? "is-disabled" : ""}`}>
      <div className="slider-head">
        <span className="slider-label">{label}</span>
        <span className="slider-value">{display}</span>
      </div>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={clamp(value, min, max)}
        disabled={disabled}
        data-testid={testId}
        onPointerDown={begin}
        onPointerUp={finish}
        onPointerCancel={finish}
        onKeyDown={(event) => {
          if (!activeRef.current) begin();
          if (event.key === "Enter") finish();
        }}
        onKeyUp={(event) => {
          if (event.key !== "Enter") finish();
        }}
        onBlur={finish}
        onChange={(event) => {
          changedRef.current = true;
          onLive(Number(event.target.value));
        }}
      />
      {hint ? <p className="field-hint">{hint}</p> : null}
    </div>
  );
}

// ── Toggle ────────────────────────────────────────────────────────────────

export interface ToggleFieldProps {
  label: string;
  checked: boolean;
  hint?: string;
  disabled?: boolean;
  testId?: string;
  onChange: (next: boolean) => void;
}

export function ToggleField({
  label,
  checked,
  hint,
  disabled,
  testId,
  onChange,
}: ToggleFieldProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle-field ${checked ? "is-on" : ""}`}
      disabled={disabled}
      data-testid={testId}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-copy">
        <span className="toggle-label">{label}</span>
        {hint ? <span className="toggle-hint">{hint}</span> : null}
      </span>
      <span className="switch" aria-hidden="true">
        <span className="switch-knob" />
      </span>
    </button>
  );
}

// ── Select ────────────────────────────────────────────────────────────────

export interface SelectOption {
  value: string | number;
  label: string;
  disabled?: boolean;
}

export interface SelectFieldProps {
  label: string;
  value: string | number;
  options: SelectOption[];
  hint?: string;
  testId?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}

export function SelectField({
  label,
  value,
  options,
  hint,
  testId,
  disabled,
  onChange,
}: SelectFieldProps) {
  return (
    <label className="select-field">
      <span className="select-label">{label}</span>
      <select
        value={String(value)}
        disabled={disabled}
        data-testid={testId}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={String(option.value)} value={String(option.value)} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

// ── Progress bar ──────────────────────────────────────────────────────────

export function ProgressBar({ value, tone = "accent" }: { value: number; tone?: "accent" | "error" }) {
  const percent = Math.round(clamp(value, 0, 1) * 100);
  return (
    <div
      className={`progress-track ${tone === "error" ? "is-error" : ""}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <div className="progress-fill" style={{ width: `${percent}%` }} />
    </div>
  );
}

// ── Modal ─────────────────────────────────────────────────────────────────

export interface ModalProps {
  open: boolean;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  testId?: string;
  onClose: () => void;
}

export function Modal({
  open,
  title,
  subtitle,
  children,
  footer,
  width = 560,
  testId,
  onClose,
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="modal-layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
        style={{ width }}
      >
        <header className="modal-head">
          <div className="modal-titles">
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭"
            data-testid={testId ? `${testId}-close` : undefined}
            onClick={onClose}
          >
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

// ── Panel scroll hint ─────────────────────────────────────────────────────

/**
 * Tracks whether a scroll container has hidden content below the fold. Used to
 * show an explicit "scroll for more" affordance: Playwright/headless Chromium
 * hides native scrollbars, so relying on the scrollbar alone is not enough.
 */
export function useScrollHint() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [hint, setHint] = useState({ scrollable: false, atBottom: true });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const scrollable = element.scrollHeight > element.clientHeight + 4;
      const atBottom =
        element.scrollTop + element.clientHeight >= element.scrollHeight - 6;
      setHint((previous) =>
        previous.scrollable === scrollable && previous.atBottom === atBottom
          ? previous
          : { scrollable, atBottom },
      );
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => {
      element.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, []);

  return { ref, ...hint };
}

export function ScrollHint({
  visible,
  testId,
  children,
}: {
  visible: boolean;
  testId?: string;
  children: ReactNode;
}) {
  if (!visible) return null;
  return (
    <div className="panel-scroll-hint" data-testid={testId} aria-hidden="true">
      {children}
    </div>
  );
}

// ── Misc ──────────────────────────────────────────────────────────────────

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function Swatch({ color, size = 12 }: { color: string; size?: number }) {
  return (
    <span
      className="swatch"
      aria-hidden="true"
      style={{ background: color, width: size, height: size }}
    />
  );
}
