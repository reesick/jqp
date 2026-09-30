"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, CornerDownLeft } from "./icons";

interface Command {
  id: string;
  label: string;
  group: "Go to" | "Actions";
  href: string;
  /** Two-key sequence shown as a hint, e.g. "G H". */
  keys?: string;
  keywords?: string;
}

const COMMANDS: Command[] = [
  { id: "home", label: "Go to Home", group: "Go to", href: "/", keys: "G H", keywords: "overview dashboard" },
  { id: "posts", label: "Go to Posts", group: "Go to", href: "/posts", keys: "G P", keywords: "carousel publish" },
  { id: "automations", label: "Go to Automations", group: "Go to", href: "/campaigns", keys: "G A", keywords: "campaigns comment dm" },
  { id: "activity", label: "Go to Activity", group: "Go to", href: "/dm-activity", keys: "G Y", keywords: "dm log history" },
  { id: "settings", label: "Go to Settings", group: "Go to", href: "/settings", keys: "G S", keywords: "instagram account connect token" },
  { id: "ingest", label: "Ingest folder", group: "Actions", href: "/posts", keywords: "add new post upload" },
  { id: "failed-posts", label: "View failed posts", group: "Actions", href: "/posts", keywords: "errors retry" },
  { id: "failed-dms", label: "View failed DMs", group: "Actions", href: "/dm-activity?status=FAILED", keywords: "errors retry messages" }
];

const SEQUENCE_ROUTES: Record<string, string> = {
  h: "/",
  p: "/posts",
  a: "/campaigns",
  y: "/dm-activity",
  s: "/settings"
};

export const OPEN_PALETTE_EVENT = "jqp:open-palette";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function matches(command: Command, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = `${command.label} ${command.keywords ?? ""}`.toLowerCase();
  // Every whitespace-separated term must appear somewhere.
  return q.split(/\s+/).every((term) => haystack.includes(term));
}

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const pendingG = useRef<ReturnType<typeof setTimeout> | null>(null);

  const results = useMemo(() => COMMANDS.filter((c) => matches(c, query)), [query]);

  const openPalette = useCallback(() => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setIndex(0);
    setOpen(true);
  }, []);

  const closePalette = useCallback(() => {
    setOpen(false);
    returnFocus.current?.focus?.();
  }, []);

  const run = useCallback(
    (command: Command | undefined) => {
      if (!command) return;
      setOpen(false);
      router.push(command.href);
    },
    [router]
  );

  // Global shortcuts.
  useEffect(() => {
    function clearG() {
      if (pendingG.current) clearTimeout(pendingG.current);
      pendingG.current = null;
    }

    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        clearG();
        if (open) closePalette();
        else openPalette();
        return;
      }
      if (open || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;

      const key = e.key.toLowerCase();
      if (key === "/") {
        e.preventDefault();
        clearG();
        openPalette();
        return;
      }
      if (pendingG.current) {
        const route = SEQUENCE_ROUTES[key];
        clearG();
        if (route) {
          e.preventDefault();
          router.push(route);
        }
        return;
      }
      if (key === "g") {
        pendingG.current = setTimeout(clearG, 1200);
      }
    }

    function onOpenRequest() {
      if (!open) openPalette();
    }

    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpenRequest);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpenRequest);
      clearG();
    };
  }, [open, openPalette, closePalette, router]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>("[aria-selected='true']")?.scrollIntoView({ block: "nearest" });
  }, [index, results]);

  if (!open) return null;

  function onInputKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(results[index]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePalette();
    } else if (e.key === "Tab") {
      // Focus trap: the input is the only tabbable control in the dialog.
      e.preventDefault();
    }
  }

  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closePalette()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-input-row">
          <Search size={15} aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            className="palette-input"
            placeholder="Search or run a command…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={onInputKeyDown}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={results[index] ? `palette-opt-${results[index].id}` : undefined}
            aria-label="Search commands"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="kbd">Esc</kbd>
        </div>
        <ul className="palette-list" id="palette-list" role="listbox" aria-label="Commands" ref={listRef}>
          {results.length === 0 ? (
            <li className="palette-empty" role="presentation">
              No commands match &ldquo;{query}&rdquo;.
            </li>
          ) : (
            results.map((c, i) => (
              <li
                key={c.id}
                id={`palette-opt-${c.id}`}
                role="option"
                aria-selected={i === index}
                className={`palette-item${i === index ? " selected" : ""}`}
                onMouseMove={() => i !== index && setIndex(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => run(c)}
              >
                <span>{c.label}</span>
                {c.keys ? (
                  <span className="palette-keys" aria-label={`Shortcut ${c.keys}`}>
                    {c.keys.split(" ").map((k) => (
                      <kbd className="kbd" key={k}>
                        {k}
                      </kbd>
                    ))}
                  </span>
                ) : i === index ? (
                  <CornerDownLeft size={13} aria-hidden="true" />
                ) : null}
              </li>
            ))
          )}
        </ul>
        <div className="palette-footer">
          <span>
            <kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> navigate
          </span>
          <span>
            <kbd className="kbd">↵</kbd> open
          </span>
          <span>
            <kbd className="kbd">G</kbd> then a letter to jump
          </span>
        </div>
      </div>
    </div>
  );
}

/** Sidebar footer hint + click target. Desktop only (hidden with the footer on mobile). */
export function PaletteHint() {
  const [mac, setMac] = useState(false);
  useEffect(() => {
    setMac(/Mac|iPhone|iPad/.test(navigator.platform));
  }, []);
  return (
    <button
      type="button"
      className="ghost palette-hint"
      onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))}
      aria-label="Open command palette"
    >
      <Search size={14} aria-hidden="true" />
      <span>Search</span>
      <span className="palette-keys">
        <kbd className="kbd">{mac ? "⌘" : "Ctrl"}</kbd>
        <kbd className="kbd">K</kbd>
      </span>
    </button>
  );
}
