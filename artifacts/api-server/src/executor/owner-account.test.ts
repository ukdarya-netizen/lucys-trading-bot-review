import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { pool } from "@workspace/db";
import { loadAccounts } from "./accounts";
import { listSignals, saveOwnerAccount, type KeyCheck } from "./owner-account";
import { ensureExecutorTables, inboxPut } from "./store";

const KEY = "A".repeat(32), SECRET = "B".repeat(40);
const okCheck: KeyCheck = async () => ({ ok: true, equity: 500 });

beforeEach(async () => {
  process.env.SUBSCRIBER_KEYS_SECRET = "x".repeat(40);
  delete process.env.BINGX_API_KEY; delete process.env.BINGX_API_SECRET; delete process.env.EXECUTOR_OWNER_VST;
  process.env.EXECUTOR_SUBSCRIBERS = "0";
  await ensureExecutorTables();
  await pool.query("DELETE FROM ex_owner_account");
  await pool.query("DELETE FROM ex_trades WHERE account_id LIKE 'owner-%'");
});

test("owner account: PAPER needs no key; VST and REAL use the key saved in the cabinet; REAL needs a confirmation", async () => {
  assert.deepEqual(await loadAccounts(), []); // nothing chosen, no key in Secrets: no account (as «Счетов нет»)
  let r = await saveOwnerAccount({ mode: "paper" }, okCheck);
  assert.ok(r.ok);
  let acc = await loadAccounts();
  assert.equal(acc[0]?.id, "owner-paper");
  assert.equal(acc[0]?.paper, true);

  r = await saveOwnerAccount({ mode: "real", apiKey: KEY, apiSecret: SECRET }, okCheck);
  assert.ok(!r.ok && r.status === 400);
  r = await saveOwnerAccount({ mode: "real", apiKey: KEY, apiSecret: SECRET, confirmReal: true }, okCheck);
  assert.ok(r.ok && r.info.mode === "real" && r.info.keyLast4 === "AAAA");
  acc = await loadAccounts();
  assert.equal(acc[0]?.id, "owner-real");
  assert.equal(acc[0]?.env, "real");
  assert.equal(acc[0]?.key, KEY);
  const stored = (await pool.query("SELECT api_key_encrypted FROM ex_owner_account")).rows[0].api_key_encrypted as string;
  assert.ok(!stored.includes(KEY)); // encrypted at rest

  r = await saveOwnerAccount({ mode: "vst" }, okCheck); // the saved key is used for VST too
  assert.ok(r.ok);
  assert.equal((await loadAccounts())[0]?.id, "owner-vst");
});

test("owner account: a refused key is not saved; the mode does not change while trades are open", async () => {
  const bad: KeyCheck = async () => ({ ok: false, message: "BingX не принял ключ" });
  const r = await saveOwnerAccount({ mode: "vst", apiKey: KEY, apiSecret: SECRET }, bad);
  assert.ok(!r.ok && r.status === 422);
  assert.deepEqual(await loadAccounts(), []);

  process.env.BINGX_API_KEY = KEY; process.env.BINGX_API_SECRET = SECRET;
  assert.equal((await loadAccounts())[0]?.id, "owner-vst"); // Secrets key, as before
  await pool.query(
    `INSERT INTO ex_trades (account_id, source, source_signal_id, symbol, side, env, status, signal_at, received_at)
     VALUES ('owner-vst', 'cab', 'cab-signal-990001', 'BIRBUSDT', 'long', 'vst', 'open', now(), now())`);
  const sw = await saveOwnerAccount({ mode: "paper" }, okCheck);
  assert.ok(!sw.ok && sw.status === 409);
});

test("signals list: every received signal with what each account did (or nothing when there was no account)", async () => {
  await pool.query("DELETE FROM ex_inbox WHERE source_signal_id IN ('cab-signal-990002', 'nh-signal-990003')");
  await inboxPut("signal", "cab-signal-990002", "cab-signal-990002", { sourceSignalId: "cab-signal-990002", symbol: "BIRBUSDT", side: "buy", stopLoss: 90, referencePrice: 100, signalAt: new Date().toISOString() });
  await inboxPut("signal", "nh-signal-990003", "nh-signal-990003", { sourceSignalId: "nh-signal-990003", symbol: "UAIUSDT", side: "short", stopLoss: 1.2, signalAt: new Date().toISOString() });
  await pool.query(
    `INSERT INTO ex_trades (account_id, source, source_signal_id, symbol, side, env, status, reason, signal_at, received_at)
     VALUES ('owner-vst', 'cab', 'cab-signal-990002', 'BIRBUSDT', 'long', 'vst', 'skipped', 'source_disabled', now(), now())`);
  const rows = (await listSignals(3)).filter((s) => s.sourceSignalId.endsWith("99000" + s.sourceSignalId.slice(-1)));
  const cab = rows.find((s) => s.sourceSignalId === "cab-signal-990002")!;
  const nh = rows.find((s) => s.sourceSignalId === "nh-signal-990003")!;
  assert.equal(cab.source, "cab"); assert.equal(cab.side, "long"); assert.equal(cab.stop, 90); assert.equal(cab.entry, 100);
  assert.equal(cab.trades[0]?.status, "skipped");
  assert.equal(cab.trades[0]?.reasonText, "торговля по этому источнику выключена в настройках");
  assert.equal(nh.source, "nihilist"); assert.equal(nh.side, "short"); assert.deepEqual(nh.trades, []);
});
