# Design decisions

Short records of the choices that shape this codebase: the context, the decision, and the
trade-off accepted.

## 1. A transport-independent `ToolExecutor` owns every guardrail

**Context:** validation, authorization, tracing, timeouts, auditing and error mapping must apply to
every tool, identically, whether the call arrives over stdio or HTTP.
**Decision:** tools are plain objects (`schema + handler`). One `ToolExecutor` runs the same
pipeline for every call. The MCP layer (`server.ts`) only translates protocol messages.
**Trade-off:** one extra layer of indirection. In return, a new tool cannot forget a guardrail, and
the guardrails are unit-tested once without any transport involved.

## 2. Low-level MCP `Server`, not `McpServer`

**Context:** `McpServer.registerTool` validates input inside the SDK. A rejected call then never
reaches our code, so it would not be audited and would return a differently shaped error.
**Decision:** use the low-level `Server` (the SDK's API for advanced use) and publish the JSON
Schemas ourselves with `z.toJSONSchema`.
**Trade-off:** the SDK marks `Server` as deprecated for general use. If a future SDK removes it,
the adapter (about 180 lines) would move to `McpServer` with tools registered against its
underlying server. The lint suppression for this is scoped to `server.ts` and explains itself.

## 3. Authorization and masking live in the data layer

**Context:** the requirement is that analysts never see customer names.
**Decision:** every repository method takes the `Principal`, and masking is applied while rows are
mapped. Tools have no way to request unmasked data. Strict output schemas act as a second, separate
allow-list.
**Trade-off:** the repository is aware of roles. That is intentional: it sits closest to the data,
and the same place will hold row-level rules (such as regional scoping) later.

## 4. Static SQL only; identifiers come from allow-lists

**Decision:** every statement is a constant string. Optional filters use the
`(@p IS NULL OR col = @p)` pattern instead of assembling WHERE clauses. Multi-value filters use
`json_each(@param)`. ORDER BY and GROUP BY columns are looked up by key in constant maps, with
an own-property check so prototype keys such as `constructor` fail. The data connection is
`readonly` with `query_only = ON`. A test fails the build if any `prepare`/`exec` interpolates a
value.
**Trade-off:** a catch-all predicate can stop the query planner from using some indexes. At this
data size that doesn't matter. At scale I would prepare a few specialized statements per common
filter combination, still without string building.

## 5. Audit store: separate, append-only, fail-closed

**Decision:** audit records go to their own database file. That lets the portfolio connection stay
read-only, and the audit trail can be retained and shipped independently. Triggers reject UPDATE
and DELETE. If the audit write fails, the result is withheld ("no audit, no data"). Arguments
are stored after validation and capped at 4 KB.

Anything that returns data is audited: tool calls, resource reads and prompt reads. Each record
carries a `kind` (`tool`, `resource`, `prompt`) and a `name` (tool name, resource URI or prompt
name). All three go through the same `ToolExecutor` audit step, so they share the identity check,
tracing and fail-closed behaviour. Listing tools, resources or prompts returns no data and is not
audited. Audit stores created before `kind` existed are upgraded in place on startup: the `tool`
column is renamed to `name`, and existing rows are labelled `tool`. No rows are rewritten.

**Trade-off:** an audit-store outage becomes a service outage. That is the right default for
regulated financial data; a deployment that preferred availability could use an asynchronous,
durable queue instead.

## 6. Stateless Streamable HTTP

**Decision:** every POST creates a fresh server/transport pair bound to that request's verified
identity. GET and DELETE return 405.
**Trade-off:** no server-initiated notifications or resumable streams, which read-only
request/response tools don't need. In return there is no session state, no sticky sessions, and no
way for one caller's identity to leak into another's session.

## 7. JWT verification with `jose` behind the SDK's bearer middleware

**Decision:** the SDK's `requireBearerAuth` supplies standards-compliant 401/403 responses and
`WWW-Authenticate` challenges, and our `jose` verifier supplies the cryptography. Accepted
algorithms are pinned to the key source (asymmetric for JWKS, HMAC for a secret). `sub` and `exp`
are required. Failure messages are deliberately vague. A token with no recognised role gets a 403,
not a fallback role.
**Trade-off:** the role comes from a single claim. Richer policy (scopes per tool, attributes) would
go into `Permissions` and `allowedRoles`.

## 8. Timeouts are cooperative

**Context:** better-sqlite3 runs synchronously on the event loop, so no JavaScript timer can stop a
statement while it is executing.
**Decision:** each tool call races against a timeout and the client's cancellation signal, and is
reported as `TIMEOUT`. Query cost is bounded structurally: indexes, LIMITs, page ceilings, and a
36-month cap on the recursive trend query. The repository interface is async, so a networked driver
can add real server-side `statement_timeout` with no change to callers.
**Trade-off:** documented as a known limitation rather than hidden behind worker threads, which
would add complexity without improving the demo's real-world behaviour.

## 9. One definition for each metric

**Decision:** metric definitions live in `schemas/metrics.ts` and are served verbatim by
`explain_metric`. Loan status is _derived_ from payment history in the seed, and the trend query
recomputes delinquency from payments at each month-end. Tests assert that the trend's final point
equals the summary's delinquency rate, overall and per segment.
**Trade-off:** the trend query is heavier than reading a snapshot table. In exchange, the two
numbers an executive will compare can never disagree.

## 10. Money as integer cents, dates as ISO text

**Decision:** money is stored as `INTEGER` cents and converted to dollars only at the boundary.
Dates are `YYYY-MM-DD` strings compared lexically; date arithmetic is done in UTC.
**Trade-off:** none worth noting. This avoids floating-point drift and timezone bugs.

## 11. Deterministic synthetic data

**Decision:** Faker with a fixed seed and an explicit as-of date. The generator models regional and
product risk multipliers, a six-month deterioration trend, and a payment state machine (on time,
late, missed, cured, defaulted). Every e-mail address uses `example.com`.
**Trade-off:** the generator is a modelling simplification and is clearly labelled as one. Its job
is plausible demo data, not credit modelling.

## 12. Node 22+ (not 20) and TypeScript 6.0

**Context:** the brief said Node 20+. Node 20 reached end of life in April 2026, and the current
better-sqlite3 (13) and Vitest (5) require Node 22 or later.
**Decision:** `engines: >=22`. CI tests 22 and 24, and the Docker image uses 22 LTS. TypeScript is
pinned to 6.0 because typescript-eslint does not support TypeScript 7 yet.

## 13. Logs and traces on stderr

**Decision:** with stdio, stdout _is_ the protocol, so pino writes to fd 2 and the console span
exporter writes to stderr. The smoke test runs the built server with logging and tracing enabled
to prove the stream stays clean.

## 14. Offset pagination

**Decision:** `page` and `pageSize` (at most 50), returning `totalCount`, `totalPages` and
`hasMore`. LLMs use this shape reliably, and the data is a static snapshot.
**Trade-off:** offset paging is not stable under concurrent writes. A live source should use keyset
or cursor pagination.
