import assert from "node:assert/strict";
import { test } from "node:test";
import { missingSourceSignals, sourceActionKind, sourceSyncConfirmed } from "./source-state";

test("explicit source cancellations close; review-only actions do not", () => {
  // Owner 2026-11-09: a reclassified (neutrally closed) signal closes the position too.
  for (const action of ["close", "cancelled", "canceled", "cancel_entry", "SMART CANCEL", "reclassified"]) {
    assert.equal(sourceActionKind(action), "close", action);
  }
  for (const action of ["position_review", "review"]) {
    assert.equal(sourceActionKind(action), "review", action);
  }
  assert.equal(sourceActionKind("review", "cancelled"), "close");
  assert.equal(sourceActionKind("position_review", "canceled"), "close");
  assert.equal(sourceActionKind("review", "reclassified"), "close");
  assert.equal(sourceActionKind("hold"), "hold");
  assert.equal(sourceActionKind(""), "unknown");
  assert.equal(sourceActionKind("new_action"), "unknown");
});

test("a source sync is confirmed only when successful, recent, and in the past", () => {
  assert.equal(sourceSyncConfirmed({ at: 99_950, ok: true, error: null }, 100_000), true);
  assert.equal(sourceSyncConfirmed({ at: 9_999, ok: true, error: null }, 100_000), false);
  assert.equal(sourceSyncConfirmed({ at: 99_950, ok: false, error: "timeout" }, 100_000), false);
  assert.equal(sourceSyncConfirmed({ at: null, ok: null, error: null }, 100_000), false);
  assert.equal(sourceSyncConfirmed({ at: 100_001, ok: true, error: null }, 100_000), false);
});

test("missing an active source signal makes the position sync incomplete", () => {
  assert.deepEqual(missingSourceSignals(["cab-1", "cab-2"], ["cab-1"]), ["cab-2"]);
  assert.deepEqual(missingSourceSignals(["cab-1"], ["cab-1"]), []);
});
