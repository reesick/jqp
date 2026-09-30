"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Spinner } from "./spinner";
import { useToast } from "./toast";

export function IngestForm() {
  const router = useRouter();
  const { toast } = useToast();
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
        toast("Couldn't ingest folder", { kind: "error" });
        return;
      }
      setFolderPath("");
      toast("Folder ingested");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      toast("Couldn't ingest folder", { kind: "error" });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card">
      <label htmlFor="ingest-folder">
        Add a post folder
        <span className="hint">Absolute path to a folder containing 1.jpg, 2.jpg, ..., caption.md</span>
      </label>
      <input
        id="ingest-folder"
        type="text"
        className="mono-input"
        value={folderPath}
        onChange={(e) => setFolderPath(e.target.value)}
        placeholder="D:\jqp\posts\POST_001"
        required
      />
      <div className="u-mt-sm">
        <button type="submit" disabled={pending} aria-busy={pending}>
          {pending ? (
            <>
              <Spinner size={13} /> Ingesting…
            </>
          ) : (
            "Ingest folder"
          )}
        </button>
      </div>
      {error ? (
        <div className="error-box" role="alert">
          Couldn&rsquo;t ingest that folder: {error}. Check the path exists on the machine running the worker and
          contains numbered images and caption.md.
        </div>
      ) : null}
    </form>
  );
}
