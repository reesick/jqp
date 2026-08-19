export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="22" height="22" rx="6" fill="#0066cc" />
      <path d="M8.2 5.8h5.4v7.1c0 2.16-1.5 3.5-3.6 3.5-1.5 0-2.7-.62-3.4-1.72l1.28-1.1c.44.68 1.1 1.06 1.98 1.06 1.06 0 1.74-.66 1.74-1.8V7.6H8.2V5.8z" fill="#fff" />
    </svg>
  );
}
