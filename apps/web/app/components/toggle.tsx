"use client";

export function Toggle({
  checked,
  onChange,
  label,
  id
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: React.ReactNode;
  id: string;
}) {
  return (
    <div className="toggle-row">
      <label htmlFor={id} className="toggle-row-label">
        {label}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        className={`toggle${checked ? " on" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span className="toggle-thumb" />
      </button>
    </div>
  );
}
