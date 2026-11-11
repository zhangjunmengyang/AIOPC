/** @jsxImportSource react */

/** The AIOPC mark: the company as an open ring, and one person carrying the idea out of it. */
export function AiopcMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none" width={size} height={size}
      className={className} role="img" aria-label="AIOPC">
      <path d="M 345 165 A 176 176 0 1 0 412 282" stroke="currentColor" strokeWidth="76" strokeLinecap="round" />
      <circle cx="404" cy="155" r="56" fill="#FF7A1A" />
    </svg>
  );
}
