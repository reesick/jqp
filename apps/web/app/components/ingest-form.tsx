"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Spinner } from "./spinner";

export function IngestForm() {
  const router = useRouter();
  const [folderPath, setFolderPath] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/posts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ folderPath })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        setError(json.error ?? `Request failed (${res.status})`);
        return;
      }
      setFolderPath("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card">
      <label>
        Add a post folder
        <span className="hint">Absolute path to a folder containing 1.jpg, 2.jpg, ..., caption.md</span>
        <input
          type="text"
          value={folderPath}
          onChange={(e) => setFolderPath(e.target.value)}
          placeholder="D:\jqp\posts\POST_001"
          required
        />
      </label>
      <button type="submit" disabled={pending} aria-busy={pending}>
        {pending ? (
          <>
            <Spinner size={13} /> Ingesting…
          </>
        ) : (
          "Ingest folder"
        )}
      </button>
      {error ? <div className="error-box">{error}</div> : null}
    </form>
  );
}
