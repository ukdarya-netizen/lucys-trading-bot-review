import { createHash } from "node:crypto";
import { BingXError, createBingX, HOSTS } from "./bingx";

type Balance = { equity: number; available: number };
type BalanceResult = {
  balance: Balance | null;
  balanceStatus: "available" | "unavailable";
  balanceError: string | null;
  checkedAt: string;
};

let cache: { fingerprint: string; expiresAt: number; result: Promise<BalanceResult> } | null = null;

/**
 * Display-only account discovery. Never load trading accounts, register a runtime,
 * change exchange settings, or place orders here.
 */
export async function ownerAccountDisplay(activeBalance: Balance | null, tradingEnabled: boolean) {
  const key = process.env.BINGX_API_KEY?.trim();
  const secret = process.env.BINGX_API_SECRET?.trim();
  if (!key || !secret) return null;

  const account = {
    id: "owner-vst",
    label: "BingX VST",
    env: "vst" as const,
    tradingEnabled,
  };
  if (activeBalance && Number.isFinite(activeBalance.equity) && Number.isFinite(activeBalance.available)) {
    return {
      ...account, balance: activeBalance, balanceStatus: "available" as const,
      balanceError: null, checkedAt: new Date().toISOString(),
    };
  }

  const fingerprint = createHash("sha256").update(JSON.stringify([key, secret])).digest("hex");
  if (!cache || cache.fingerprint !== fingerprint || cache.expiresAt <= Date.now()) {
    const entry = {
      fingerprint,
      expiresAt: Number.POSITIVE_INFINITY,
      result: readBalance(key, secret),
    };
    entry.result = entry.result.finally(() => {
      entry.expiresAt = Date.now() + 30_000;
    });
    cache = entry;
  }
  return { ...account, ...await cache.result };
}

async function readBalance(key: string, secret: string): Promise<BalanceResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9_000);
  try {
    // Hard allowlist: even future client changes cannot make this display path
    // send orders or perform any other exchange operation.
    const readOnlyFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (init?.method !== "GET" || url.origin !== HOSTS.vst ||
          url.pathname !== "/openApi/swap/v3/user/balance") {
        throw new Error("Read-only account request rejected");
      }
      controller.signal.throwIfAborted();
      return fetch(input, { ...init, signal: controller.signal });
    };
    const balance = await createBingX({ env: "vst", key, secret, fetchImpl: readOnlyFetch }).balance();
    if (!Number.isFinite(balance.equity) || !Number.isFinite(balance.available)) {
      throw new Error("Invalid balance response");
    }
    return { balance, balanceStatus: "available", balanceError: null, checkedAt: new Date().toISOString() };
  } catch (error) {
    // Never return raw exchange messages, request URLs, keys or signatures.
    const code = error instanceof BingXError && error.code !== null ? ` (код ${error.code})` : "";
    return {
      balance: null, balanceStatus: "unavailable",
      balanceError: `Не удалось прочитать баланс BingX VST${code}. Проверьте ключи и доступ к демо-счёту.`,
      checkedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timeout);
  }
}
