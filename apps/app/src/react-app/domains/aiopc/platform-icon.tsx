/** @jsxImportSource react */
import { cn } from "@/lib/utils";

// Bundled brand artwork; sources and licenses: src/assets/platforms/NOTICE.md.
const LOGOS = import.meta.glob<string>("../../../assets/platforms/*.svg", { eager: true, query: "?url", import: "default" });
const BY_ID = Object.fromEntries(Object.entries(LOGOS).map(([path, url]) => [path.split("/").pop()!.replace(/\.svg$/, ""), url]));

/** A platform's logo, or its first character on its brand color when no artwork is bundled. */
export function PlatformIcon(props: { id: string; name: string; color?: string; className?: string; muted?: boolean; large?: boolean }) {
  const logo = BY_ID[props.id];
  return (
    <span
      className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg bg-white shadow-xs ring-1 ring-black/5 dark:bg-white/90",
        props.muted && "opacity-50 grayscale", props.className)}
      aria-hidden
    >
      {logo ? (
        <img src={logo} alt="" className="size-[60%] object-contain" />
      ) : (
        <span className={cn("font-semibold", props.large ? "text-lg" : "text-[13px]")} style={{ color: props.color || "currentColor" }}>{props.name.slice(0, 1)}</span>
      )}
    </span>
  );
}
