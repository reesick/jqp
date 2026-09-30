"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Check, X, AlertTriangle } from "./icons";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  kind?: "success" | "error" | "info";
  action?: ToastAction;
}

interface ToastItem extends ToastOptions {
  id: number;
  message: string;
}

interface ToastApi {
  toast: (message: string, options?: ToastOptions) => void;
}

const ToastContext = createContext<ToastApi>({ toast: () => {} });

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

const MAX_VISIBLE = 3;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, options: ToastOptions = {}) => {
      const id = nextId.current++;
      setItems((prev) => [...prev.slice(-(MAX_VISIBLE - 1)), { id, message, ...options }]);
      // Toasts with an action (Retry) stay a little longer so they can be hit.
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), options.action ? 6000 : 3000)
      );
    },
    [dismiss]
  );

  // Esc dismisses the newest toast (never steals Esc when an overlay is open).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector("[aria-modal='true']")) return;
      setItems((prev) => {
        const last = prev[prev.length - 1];
        if (!last) return prev;
        const timer = timers.current.get(last.id);
        if (timer) clearTimeout(timer);
        timers.current.delete(last.id);
        return prev.slice(0, -1);
      });
    }
    window.addEventListener("keydown", onKey);
    const pending = timers.current;
    return () => {
      window.removeEventListener("keydown", onKey);
      pending.forEach((t) => clearTimeout(t));
      pending.clear();
    };
  }, []);

  const api = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-region" role="status" aria-live="polite" aria-atomic="false">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind ?? "success"}`}>
            <span className="toast-icon" aria-hidden="true">
              {t.kind === "error" ? <AlertTriangle size={14} /> : <Check size={14} />}
            </span>
            <span className="toast-message">{t.message}</span>
            {t.action ? (
              <button
                type="button"
                className="secondary toast-action"
                onClick={() => {
                  dismiss(t.id);
                  t.action?.onClick();
                }}
              >
                {t.action.label}
              </button>
            ) : null}
            <button type="button" className="ghost toast-close" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
