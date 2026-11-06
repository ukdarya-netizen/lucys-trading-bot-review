/**
 * Owner 2026-11-06: what a non-owner sees. Not approved yet (or rejected/blocked) → the cabinet page as
 * before. Approved → an app like the owner's (sidebar on desktop, bottom tabs in the Telegram Mini App)
 * with four pages, all about the subscriber's own account only: Обзор, Позиции, История, Кабинет.
 */
import { Switch, Route, Link, Redirect, useLocation } from "wouter";
import { useClerk, useUser } from "@clerk/react";
import { LayoutDashboard, Crosshair, History, UserRound, LogOut, Terminal } from "lucide-react";
import { BrandLockup, BrandMark } from "@/components/brand";
import SubscriberCabinet, { SubscriberCabinetBody } from "../SubscriberCabinet";
import SubOverview from "./SubOverview";
import SubPositions from "./SubPositions";
import SubHistory from "./SubHistory";
import { useSubscription } from "./shared";

const SUB_NAV = [
  { href: "/journal/overview", label: "Обзор", sub: "мой результат и статус бота", icon: LayoutDashboard },
  { href: "/journal/positions", label: "Позиции", sub: "открытые сейчас", icon: Crosshair },
  { href: "/journal/trades", label: "История", sub: "закрытые сделки", icon: History },
  { href: "/journal/my-bot", label: "Кабинет", sub: "ключ, боты, размер, вкл/выкл", icon: UserRound },
] as const;

export default function SubscriberApp() {
  const q = useSubscription();
  const [location] = useLocation();
  const { signOut } = useClerk();
  const { user } = useUser();

  if (q.isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center text-muted-foreground">
        <Terminal className="animate-pulse w-6 h-6" />
      </div>
    );
  }
  // Pending, rejected, blocked or a load error: the existing cabinet page handles all of these.
  if (q.data?.subscription.status !== "approved") return <SubscriberCabinet />;

  const current = SUB_NAV.find((i) => i.href === location) ?? null;
  return (
    <div className="cyber-shell min-h-[100dvh] bg-background flex flex-col md:flex-row">
      <aside className="cyber-sidebar hidden md:flex md:sticky md:top-0 md:h-[100dvh] w-60 border-r border-border flex-col flex-shrink-0">
        <div className="cyber-brand h-[72px] px-5 border-b border-border flex items-center"><BrandLockup /></div>
        <nav className="flex-1 py-4 px-3 space-y-0.5" aria-label="Разделы">
          {SUB_NAV.map((item) => {
            const active = location === item.href;
            const Icon = item.icon;
            return (
              <Link key={item.href} href={item.href} data-active={active} aria-current={active ? "page" : undefined}
                className={`cyber-nav-link flex items-start px-3 py-2.5 text-sm font-medium transition-colors ${active ? "text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
                <Icon className="w-4 h-4 mr-3 mt-0.5 shrink-0" />
                <span className="flex min-w-0 flex-col">
                  <span>{item.label}</span>
                  <span className={`text-xs font-normal ${active ? "text-primary/60" : "text-muted-foreground/60"}`}>{item.sub}</span>
                </span>
              </Link>
            );
          })}
        </nav>
        <div className="px-4 py-3 border-t border-border flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs font-medium truncate">Подписчик</p>
            <p className="text-xs text-muted-foreground truncate">{user?.primaryEmailAddress?.emailAddress}</p>
          </div>
          <button onClick={() => signOut({ redirectUrl: "/" })} title="Выйти" aria-label="Выйти"
            className="shrink-0 p-1.5 hover:bg-muted text-muted-foreground hover:text-foreground"><LogOut className="w-3.5 h-3.5" /></button>
        </div>
      </aside>
      <main className="flex-1 flex flex-col min-w-0">
        <header className="cyber-mobile-header sticky top-0 z-20 flex h-14 md:h-16 items-center justify-between gap-3 border-b border-border px-4 md:px-8">
          <div className="flex items-center gap-2.5 min-w-0">
            <BrandMark className="size-7 md:hidden" />
            <div className="min-w-0">
              <span className="block md:hidden text-[9px] uppercase tracking-[0.16em] text-muted-foreground">Lucy&apos;s Trading Bot</span>
              <h1 className="truncate text-base md:text-xl font-semibold">{current?.label ?? "Кабинет"}</h1>
            </div>
          </div>
          <span className="hidden md:inline text-xs text-muted-foreground">{current?.sub}</span>
          <button type="button" onClick={() => signOut({ redirectUrl: "/" })} className="md:hidden min-h-11 px-2 text-sm font-medium text-muted-foreground">Выйти</button>
        </header>
        <div className="flex-1 overflow-y-auto p-4 pb-24 md:p-8">
          <Switch>
            <Route path="/journal/overview" component={SubOverview} />
            <Route path="/journal/positions" component={SubPositions} />
            <Route path="/journal/trades" component={SubHistory} />
            <Route path="/journal/my-bot">{() => <SubscriberCabinetBody inApp />}</Route>
            <Route><Redirect to="/journal/overview" /></Route>
          </Switch>
        </div>
        <nav aria-label="Разделы" className="cyber-mobile-nav md:hidden fixed inset-x-0 bottom-0 z-20 flex border-t border-border pb-[env(safe-area-inset-bottom)]">
          {SUB_NAV.map((item) => {
            const active = location === item.href;
            const Icon = item.icon;
            return (
              <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined}
                className={`flex min-h-16 flex-1 flex-col items-center justify-center gap-1 px-1 text-[11px] font-medium ${active ? "text-primary" : "text-muted-foreground"}`}>
                <Icon className="w-5 h-5" />{item.label}
              </Link>
            );
          })}
        </nav>
      </main>
    </div>
  );
}
