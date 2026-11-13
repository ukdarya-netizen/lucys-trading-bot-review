---
name: Nihilist cabinet rules
description: Owner-approved scope and storage constraints for personal Nihilist trading settings.
---

Each cabinet (owner and each subscriber) chooses its own Nihilist long strategy, short strategy, and allowed sides. Defaults must retain both sides and the previously selected strategy for each side. CAB must remain unchanged.

**Why:** The user requested independent personal settings without changing existing behavior until that person makes a choice.

**How to apply:** New choices govern new entries only; preserve the strategy of positions already opened. Notify the owner when a cabinet changes these choices.

Do not add columns or change the schema for these settings. Use an existing JSON field if available, otherwise a clearly named service row in an existing table.

**Why:** The user explicitly chose storage without production schema changes instead of adding columns via Publish.

**How to apply:** Preserve this storage constraint when extending the Nihilist side/strategy preferences; do not introduce startup DDL or db push for them.

Invalid saved side preferences must fall back to the legacy strategy on both sides, with a warning, rather than stop Nihilist entries.

**Why:** The user explicitly chose backward-compatible trading over blocking all signals when JSON is corrupted or a strategy is removed.

**How to apply:** Treat invalid preferences as a whole, not as independent valid fragments. Do not turn database outages into successful reads.

Reuse the canonical strategy descriptions; never infer trading rules from strategy identifiers.

**Why:** The user noted that a strategy identifier can represent partial exits or other rules, not just a full fixed take.

**How to apply:** Keep cabinet text tied to the shared descriptions when adding or revising strategies.
