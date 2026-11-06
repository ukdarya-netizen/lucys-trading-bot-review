import { cn } from "@/lib/utils";

export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-10 shrink-0 overflow-hidden rounded-full ring-1 ring-[hsl(var(--glow)/0.7)] shadow-[0_0_16px_hsl(var(--glow)/0.5)]",
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

/** Lucy's Trading Bot (owner 2026-11-04): round glowing avatar, LUCY'S in the light-blue gradient, TRADING BOT small and letter-spaced. */
export function BrandLockup({ className }: { className?: string; product?: string }) {
  return (
    <div className={cn("inline-flex items-center gap-3 text-left", className)} aria-label="Lucy's Trading Bot">
      <BrandMark />
      <span aria-hidden="true" className="flex flex-col leading-none">
        <span className="brand-bullet text-[17px] uppercase">Lucy&apos;s</span>
        <span className="brand-title mt-1 text-[9px] uppercase">Trading Bot</span>
      </span>
    </div>
  );
}
