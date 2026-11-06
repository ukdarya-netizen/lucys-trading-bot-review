import { Switch, Route, Link, Redirect, useLocation } from "wouter";
import { useAuth, useClerk, useUser } from "@clerk/react";
import { HeartPulse, LogOut, LayoutDashboard, List, History, ShieldAlert, Terminal, Wallet, Target, Database, Activity, FlaskConical, Users, UserRound, SlidersHorizontal, Archive, Crosshair, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { BrandLockup, BrandMark } from "@/components/brand";
import JournalSubscribers from "./JournalSubscribers";
import SubscriberApp from "./subscriber/SubscriberApp";
import { useGetJournalAccess, getGetJournalAccessQueryKey } from "@workspace/api-client-react";
import TradeOverview from "./TradeOverview";
import TradePositions from "./TradePositions";
import TradeHistory from "./TradeHistory";
import StrategiesPage from "./StrategiesPage";
import SignalsPage from "./SignalsPage";
import BotHealth from "./BotHealth";
import { MainAccountToggles } from "@/components/SourceToggles";

// Owner 2026-11-03: the trading bot has two signal sources (CAB and Nihilist); the main pages
// show both with one switch. The old bot's pages are gone from the site (owner: not needed).
const NAV_ITEMS = [
  { group: "Торговля", href: "/journal/overview", label: "Обзор", short: "Обзор", sub: "результат Crypto Alts Bullet и Nihilyst Crypto Trading", icon: LayoutDashboard },
  { group: "Торговля", href: "/journal/signals", label: "Сигналы", short: "Сигналы", sub: "что пришло и что сделал бот", icon: Activity },
  { group: "Торговля", href: "/journal/positions", label: "Позиции", short: "Позиции", sub: "открытые сейчас", icon: Crosshair },
  { group: "Торговля", href: "/journal/trades", label: "История", short: "История", sub: "закрытые и не открытые", icon: History },
  { group: "Управление", href: "/journal/bots", label: "Crypto Alts Bullet · Nihilyst Crypto Trading", short: "Боты", sub: "результаты стратегий", icon: SlidersHorizontal },
  { group: "Управление", href: "/journal/my-bot", label: "Мой кабинет", short: "Кабинет", sub: "торговля, стратегия, BTC", icon: UserRound },
  { group: "Управление", href: "/journal/health", label: "Bot Health", short: "Health", sub: "работает ли бот, ошибки", icon: HeartPulse },
  { group: "Люди", href: "/journal/subscribers", label: "Подписчики", short: "Подписчики", sub: "заявки, сроки, боты", icon: Users },
] as const;
const ALL_ITEMS = NAV_ITEMS;

export default function JournalLayout() {
  const [location] = useLocation();
  const { signOut } = useClerk();
  const { isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const { data: access, isLoading, error } = useGetJournalAccess({
    query: { queryKey: getGetJournalAccessQueryKey(), enabled: Boolean(isLoaded && isSignedIn), refetchInterval: 15000 }
  });

  if (!isLoaded || (isSignedIn && isLoading)) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center">
         <div className="flex items-center gap-4 text-muted-foreground">
           <Terminal className="animate-pulse w-6 h-6" />
           <span className="font-mono text-sm tracking-widest uppercase">ИНИЦИАЛИЗАЦИЯ...</span>
         </div>
      </div>
    );
  }

  if (!isSignedIn) {
    return <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="max-w-md w-full border border-border bg-card p-8 space-y-5">
        <ShieldAlert className="w-10 h-10 text-primary" />
        <h1 className="text-xl font-bold uppercase">Торговый дневник</h1>
        <p className="text-sm text-muted-foreground">Данные сделок доступны только владельцу после входа.</p>
        <Link href="/sign-in" className="block bg-primary text-primary-foreground text-center p-3 uppercase text-sm font-bold">Войти</Link>
      </div>
    </div>;
  }

  if (error || !access) {
    return <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="max-w-md w-full border border-border bg-card p-8 space-y-4">
        <h1 className="text-xl font-bold uppercase">Данные недоступны</h1>
        <p className="text-sm text-muted-foreground">Не удалось проверить доступ. Повторите попытку позже.</p>
      </div>
    </div>;
  }

  if (!access.configured) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
        <div className="max-w-md w-full border border-border bg-card p-8 text-center space-y-6 shadow-sm">
          <Terminal className="w-12 h-12 mx-auto text-primary" />
          <h2 className="text-xl font-bold tracking-tight uppercase">Ожидание настройки владельца</h2>
          <p className="text-sm text-muted-foreground">
            Владелец ещё не назначен. Журнал закрыт для всех аккаунтов.
          </p>
          <button 
            onClick={() => signOut({ redirectUrl: "/" })}
            className="w-full bg-foreground text-background h-10 font-medium text-sm hover:bg-foreground/90 transition-colors uppercase tracking-wider"
          >
            Выйти
          </button>
        </div>
      </div>
    );
  }

  // Everyone who is not the owner gets the subscriber app (owner 2026-11-06): the cabinet page while
  // not approved; once approved — Обзор, Позиции, История, Кабинет about their own account only.
  if (!access.authorized) {
    return <SubscriberApp />;
  }

  const current = ALL_ITEMS.find((item) => item.href === location) ??
    null;

  return (
    <div className="cyber-shell min-h-[100dvh] bg-background flex flex-col md:flex-row">
      <aside className="cyber-sidebar hidden md:flex md:sticky md:top-0 md:h-[100dvh] w-64 border-r border-border flex-col flex-shrink-0">
        <div className="cyber-brand h-[72px] px-5 border-b border-border flex items-center">
          <BrandLockup />
        </div>
        <nav className="flex-1 py-4 px-3 space-y-0.5 overflow-y-auto" aria-label="Разделы">
          {NAV_ITEMS.map((item, i) => (
            <div key={item.href}>
              {(i === 0 || NAV_ITEMS[i - 1]!.group !== item.group) && (
                <p className={`px-3 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground ${i ? "pt-4" : ""}`}>{item.group}</p>
              )}
              <NavLink href={item.href} icon={item.icon} active={location === item.href} sub={item.sub}>{item.label}</NavLink>
            </div>
          ))}
        </nav>
        <div className="px-4 py-3 border-t border-border flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground truncate">Владелец</p>
            <p className="text-xs text-muted-foreground truncate" title={user?.primaryEmailAddress?.emailAddress}>
              {user?.primaryEmailAddress?.emailAddress}
            </p>
          </div>
          <button
            onClick={() => signOut({ redirectUrl: "/" })}
            title="Выйти"
            aria-label="Выйти"
            className="shrink-0 p-1.5 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0">
        <header className="cyber-mobile-header sticky top-0 z-20 flex h-14 md:h-16 items-center justify-between gap-3 border-b border-border px-4 md:px-8">
          <div className="flex items-center gap-2.5 min-w-0">
            <BrandMark className="size-7 md:hidden" />
            <div className="min-w-0">
              <span className="block md:hidden text-[9px] uppercase tracking-[0.16em] text-muted-foreground">Lucy&apos;s Trading Bot</span>
              <h1 className="truncate text-base md:text-xl font-semibold">{current?.label ?? "Журнал"}</h1>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <span className="hidden md:inline text-xs text-muted-foreground">{current?.sub}</span>
            <button
              type="button"
              onClick={() => signOut({ redirectUrl: "/" })}
              className="md:hidden min-h-11 px-2 text-sm font-medium text-muted-foreground"
            >
              Выйти
            </button>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto p-4 pb-24 md:p-8">

          <Switch>
             <Route path="/journal/overview" component={TradeOverview} />
             <Route path="/journal/signals" component={SignalsPage} />
             <Route path="/journal/positions" component={TradePositions} />
             <Route path="/journal/trades" component={TradeHistory} />
             <Route path="/journal/bots" component={StrategiesPage} />
             <Route path="/journal/strategies"><Redirect to="/journal/bots" /></Route>
             <Route path="/journal/trading"><Redirect to="/journal/bots" /></Route>
             <Route path="/journal/health" component={BotHealth} />
             <Route path="/journal/subscribers" component={JournalSubscribers} />
             <Route path="/journal/my-bot">{() => <div className="mx-auto max-w-3xl space-y-4"><MainAccountToggles /></div>}</Route>
             <Route><Redirect to="/journal/overview" /></Route>
          </Switch>
        </div>
         <nav aria-label="Разделы дневника" className="cyber-mobile-nav md:hidden fixed inset-x-0 bottom-0 z-20 flex overflow-x-auto border-t border-border pb-[env(safe-area-inset-bottom)]">
          {NAV_ITEMS.map((item) => (
            <MobileNavLink key={item.href} href={item.href} active={location === item.href} icon={item.icon}>
              {item.short}
            </MobileNavLink>
          ))}

        </nav>
      </main>
    </div>
  );
}

function SwitchLink({ href, active, testId, real = false, children }: {
  href: string; active: boolean; testId: string; real?: boolean; children: React.ReactNode;
}) {
  return (
    <Link href={href} aria-current={active ? "page" : undefined} data-testid={testId}
      className={`flex min-h-11 items-center justify-center gap-2 px-3 py-2 text-center text-xs font-bold uppercase tracking-wider transition-colors border ${
        active
          ? real ? "bg-amber-500/15 text-amber-200 border-amber-400/30" : "bg-primary/10 text-primary border-primary/20"
          : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}>
      {children}
    </Link>
  );
}

function MobileNavLink({ href, icon: Icon, active, children }: { href: string; icon: typeof LayoutDashboard; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex min-h-16 min-w-[68px] flex-1 flex-col items-center justify-center gap-1 px-1 text-[11px] font-medium ${active ? "text-primary" : "text-muted-foreground"}`}
    >
      <Icon className="w-5 h-5" />
      {children}
    </Link>
  );
}

function NavLink({ href, icon: Icon, active, sub, children }: { href: string; icon: typeof LayoutDashboard; active: boolean; sub?: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      data-active={active}
      aria-current={active ? "page" : undefined}
      className={`cyber-nav-link flex items-start px-3 py-2.5 text-sm font-medium transition-colors ${
        active ? "text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      <Icon className="w-4 h-4 mr-3 mt-0.5 shrink-0" />
      <span className="flex min-w-0 flex-col">
        <span>{children}</span>
        {sub && <span className={`text-xs font-normal ${active ? "text-primary/60" : "text-muted-foreground/60"}`}>{sub}</span>}
      </span>
    </Link>
  );
}
