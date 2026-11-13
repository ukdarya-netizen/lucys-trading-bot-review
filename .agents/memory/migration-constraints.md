---
name: Trading bot migration constraints
description: Safety and source-fidelity requirements for importing the existing trading bot.
---

This project imports the user's existing Lucy's Trading Bot, not a replacement application. Preserve its code and trading rules. The user selected taking code from the old project, rather than rebuilding from the uploaded configuration files.

**Why:** Trading behavior and source fidelity must not change during migration.

**How to apply:** Use verified application source, never silently substitute a GitHub revision. Only isolated installation, builds, and executor unit tests are in scope initially. Do not copy production data, exchange or Telegram credentials, connect incoming signals, change authentication, run schema pushes or post-merge scripts, or activate trading without separate approval. Any eventual isolated runtime requires a separate empty test database and EXECUTOR_V2=1, EXECUTOR_OWNER_VST=0, EXECUTOR_SUBSCRIBERS=0, SUBSCRIBER_BOT_IN_DEV=0. EXECUTOR_V2=0 is not a safe pause.

The user approved a separate Clerk identity system only for testing, not migration
or replacement of existing accounts. Test registrations must not automatically
gain owner access or imply that original subscriber records have been transferred.

**Why:** The user selected «Да, только для тестирования» when offered a separate test login.

**How to apply:** Keep test identities separate from the original deployment.
Production identity migration, role mapping, database changes and API/trading
activation still require their own approval.

The user warns that starting the API in development with BingX keys present may
start trading. Collecting credentials is not permission to start the dev API or tests.

**Why:** The user explicitly identified development startup as a trading risk
when preparing this project's secrets.

**How to apply:** Leave the trading API stopped when collecting or updating
credentials. Do not use dev startup or test execution as a credential check.

The owner approved showing the configured BingX account and its balance while
trading remains disabled.

**Why:** A missing account in the dashboard must not require activating the
trading executor just to display it.

**How to apply:** Keep account visibility separate from trading eligibility.
Read-only display must not register a trading runtime, send orders, or change
execution flags. Do not treat saved keys as a verified exchange connection.

An enabled source preference is not proof that trading is running. The user
expects actual trading, not only a monitoring dashboard.

**Why:** The user reported that all indicators said trading was enabled while
the deployed executor had no accounts.

**How to apply:** Distinguish source permissions from effective executor/account
readiness in status messages. Keep development execution disabled; separately
identify the account and environment in the UI before its explicit activation.

The user corrected the workflow: «Я не должна включать все через тебя! Я должна
включать и выключать все в интерфейсе!»

**Why:** Normal trading controls must not require asking Agent or editing Secrets.

**How to apply:** Owner actions in the authenticated published cabinet govern
enabling and pausing VST entries. Their saved choices take precedence over the
migration-era account flags; those flags are only initial defaults. Do not
activate trading on the user's behalf while implementing the controls.
Pausing new entries must leave existing positions protected and managed.
Development must remain unable to enable trading, even when it shares settings
with production.

Global subscriber-source availability and each subscriber's personal bot access
are separate controls. Updating one must not silently change the other.

**Why:** The owner explicitly requested per-subscriber bot access in addition
to the existing shared controls.

**How to apply:** Keep global CAB/Nihilyst subscriber gates and each row's
`trade_sources` assignment independent. Existing positions remain managed when
an individual source permission changes.

Do not declare migration configuration complete after collecting credentials
alone; check required service URLs and the target deployment configuration too.

**Why:** The user encountered a missing Nihilist connection URL after being told
the configuration list was complete.

**How to apply:** Audit non-secret connection settings alongside credentials.
Distinguish saved configuration from the configuration of the currently serving
deployment, without starting development trading processes.

The user reported: «Я удалила старый проект».

**Why:** Settings can no longer be assumed available for copying from the old
trading-bot project.

**How to apply:** Use the preserved source snapshots; do not assume deleted
environment values were included. The user separately confirmed that the Nihilist
source project still exists; do not confuse it with the deleted trading-bot project.

Cross-project reading was available before this conversation moved into a project, but that callback is unavailable in the destination project. A connection made in the conversation does not guarantee continued source access after transition.

**Why:** The source project's current commit could be read before transition, but it could not be retrieved from the connected GitHub repository afterward.

**How to apply:** Confirm the source-transfer mechanism before moving a migration conversation. If source access is lost, ask for the actual source archive rather than importing a different version.

GitHub's connector proxy rejects provider redirects, so GitHub archive endpoints
can fail even when repository and blob reads work. A public repository's
commit-pinned codeload archive is an alternative; verify every downloaded blob
against the authenticated tree and the supplied checksum manifest before import.

**Why:** The archive API returned a redirect rejection, while commit-pinned public
codeload succeeded. Per-file connector downloads also hit rate limits.

**How to apply:** Prefer a verified bulk archive when it is publicly accessible;
do not retrieve or expose credentials to work around connector redirects.

For a non-applying schema preview, prefer Drizzle's CLI with `--strict --verbose`,
closed stdin, and a read-only PostgreSQL session. Inspect the SQL and final output,
not just the exit code.

**Why:** The installed Drizzle programmatic preview lost introspection query
parameters; the CLI printed a complete plan, then reported missing TTY while
returning exit status zero. Newly created foreign keys are emitted as separate
ALTER ADD statements, so even an additive plan may fail a CREATE-only condition.

**How to apply:** Never call the preview's apply operation. Respect a CREATE-only
gate literally, and do not treat successful CLI exit status as proof of application.
