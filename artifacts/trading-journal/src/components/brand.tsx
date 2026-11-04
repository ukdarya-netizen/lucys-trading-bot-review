import { cn } from "@/lib/utils";

export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-10 shrink-0 overflow-hidden rounded-full ring-1 ring-[hsl(var(--neon-violet)/0.6)] shadow-[0_0_14px_hsl(var(--neon-violet)/0.45),0_0_4px_hsl(var(--neon-cyan)/0.5)]",
        className,
      )}
    >
      <img
        src={`${import.meta.env.BASE_URL}brand-avatar.webp`}
        alt=""
        width={40}
        height={40}
        className="size-full object-cover"
        draggable={false}
      />
    </span>
  );
}

/** Lucy's Trading Bot (owner 2026-11-03): the same style — round neon avatar, title in the light gradient, the name in bold neon. */
export function BrandLockup({ className }: { className?: string; product?: string }) {
  return (
    <div className={cn("inline-flex items-center gap-3 text-left", className)} aria-label="Lucy's Trading Bot">
      <BrandMark />
      <span aria-hidden="true" className="flex flex-col leading-none">
        <span className="brand-title text-[13px] uppercase">Lucy&apos;s</span>
        <span className="brand-bullet mt-0.5 text-[19px] uppercase">Trading Bot</span>
      </span>
    </div>
  );
}
