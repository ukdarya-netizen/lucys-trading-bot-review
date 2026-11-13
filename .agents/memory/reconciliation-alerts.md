---
name: Reconciliation alerts
description: The owner's chosen response to discrepancies between the bot ledger and exchange state.
---

The owner authorized market-closing a BingX position that has no active bot trade, but only after three successful position snapshots and a fresh pre-order position/ledger check. The implementation is scoped to published owner REAL/VST; do not extend it to paper or subscriber accounts without separate approval. Never close on a timeout, malformed response, or uncertain snapshot. After confirming the position is absent, cancel only STOP/TAKE_PROFIT orders for the same symbol and side. Limit automatic close attempts.

**Why:** The owner changed the earlier alert-only decision and explicitly approved market closes for unmatched BingX positions, then approved canceling only that position-side's protective orders after closure.

**How to apply:** Restrict automatic exchange writes to published owner REAL/VST. Recheck the active ledger and current exchange position before every market order. After closure, verify absence before canceling matching protective orders. Keep normal trade management intact; do not close tracked trades because of unrelated errors.

Do not send Telegram warnings for transient reconciliation read failures; keep them in health state and logs while retrying. Never send “all positions match” or source-sync-confirmed Telegram notices. Send reconciliation notices only when reconciliation actually changed a position (closed, cancelled, or adopted); leave other trade messages unchanged. Serialize Telegram outbox delivery across production instances with a database-level lock. Close notices remain tied to confirmed exchange absence.

**Why:** The owner explicitly prohibited clean-match notices entirely and requested reconciliation messages only for actual changes. Earlier BingX failures were flapping, and duplicate Telegram delivery was also observed.

**How to apply:** Keep transient failures visible in health state and logs, not repeated chat alerts; the VST per-position read-error category is log-only. Keep close and critical trade-operation notices. Prevent multiple workers from sending the same queued Telegram message concurrently. Treat BingX `109429` as an endpoint rate limit and honor its retry-after time before retrying protective orders.

An “all positions match” notice certifies only that the executor ledger matches the BingX position snapshot for that account. It does not certify that the upstream source bot's cancellation/reclassification state was received or applied.

**Why:** Production showed an INUSDT account-level match after its executor trade had already been marked manually closed; this does not prove the upstream cancellation event was handled.

**How to apply:** Scope reconciliation status and user-facing text to the exact systems checked. Do not claim source consistency until the corresponding source event has been received and applied or explicitly marked for review.

Source-side cancellations are important and must not be dropped while a trade is `opening` or `unknown`. Once BingX confirms closure, notify that the position is closed and its ledger row is no longer in the open list.

**Why:** The owner emphasized that positions can be cancelled and must be reconciled, with a clear closure notice and removal from CAB «Открытые».

**How to apply:** Keep source position sync active for all active trade states. For unresolved entries, record the pending source close and let the exchange reconciler resolve it; only notify closure after the ledger row is marked closed.

For owner reconciliation health state, validate source sync for every source with an active trade across owner REAL/VST, not only the account whose exchange snapshot is being checked. Invalidate the previous source-sync result when a new poll starts. Treat `review` plus `sourceStatus: cancelled` as an explicit cancellation; do not report a clean source sync until the corresponding owner ledger rows are terminal. Do not send a positive Telegram notice.

**Why:** On 2026-11-08, the VST account reported a match while it had no open trades, even though an Anime trade remained open in the REAL ledger. The same period had CAB cancellation/reclassification review errors.

**How to apply:** For reconciliation health, check the current source-sync state across both owner accounts and ensure pending cancellations have been applied and confirmed. Never treat an empty account's exchange match as proof that another account's source positions are synchronized.
