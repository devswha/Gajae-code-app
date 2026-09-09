# GJC worker protocol, version 1

The interface between a **host** — an application that wants an agent — and a
**worker** — a process that runs one. This document is written so either side
can be implemented from it alone, without reading the other's source.

Gajae Code App is one host. `server/gjc-worker.ts` and its adapters are one
worker. Nothing in this protocol assumes either.

The normative implementation of the envelope, codec and correlation rules is
[`server/gjc-worker-protocol.ts`](../server/gjc-worker-protocol.ts). Where this
document and that file disagree, the file is right and this document is a bug.

## 1. Transport

Frames travel as **NDJSON over a private byte stream**. In the reference
deployment that stream is the worker's stdout and stdin, but nothing below
depends on it; a socket or a pipe pair works identically.

- Each frame is one JSON object encoded as **UTF-8**, followed by `U+000A` (LF).
- A trailing `U+000D` (CR) before the LF is accepted and stripped, so CRLF hosts
  interoperate. Emitters must not produce it.
- **Blank lines are a protocol error**, not a keepalive.
- A frame must not exceed **67,108,864 bytes (64 MiB)** measured as UTF-8. This
  applies to the encoded frame, to a single NDJSON line, and to the decoder's
  unterminated buffer.
- Input that ends mid-frame is an error (`unterminated_frame`). A decoder that
  has raised any error is poisoned and must reject all further input rather than
  resynchronize: a stream that has lost framing cannot be trusted to regain it.

A worker that shares its output stream with anything else must keep that traffic
off it. The reference worker claims stdout for frames alone and redirects every
other write to stderr, because one stray `console.log` from a library corrupts
the stream and the host kills the worker.

## 2. Envelope

Every frame is a JSON object with exactly these fields and no others. Unknown
fields are rejected rather than ignored — a field the receiver does not
understand is a version mismatch wearing a disguise.

| Field | Type | Present |
| --- | --- | --- |
| `protocolVersion` | `1` | always |
| `kind` | `"request" \| "response" \| "event"` | always |
| `id` | identifier | always |
| `method` | string | always |
| `sessionId` | identifier | by scope, see §4 |
| `payload` | object | always |

**Identifiers** — both `id` and `sessionId` — must match
`^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$`. Begins alphanumeric, then alphanumerics,
dot, underscore, colon or hyphen, at most 256 characters. The character set is
deliberately narrow: these values reach log lines, file names and process
arguments.

**Payload values** must be JSON in the strict sense the codec enforces:

- Objects must be plain — prototype `Object.prototype` or `null`. A class
  instance, a `Map`, a `Date` is not a payload value.
- Numbers must be finite. `NaN` and infinities are rejected rather than coerced
  to `null` as `JSON.stringify` would do silently.
- No circular references.

## 3. Frame kinds

**`request`** — the host asks the worker to do something. Every request must
receive exactly one response.

**`response`** — the worker's answer. `id` and `method` must equal the request's,
and the session scope must match. A response whose `id` is unknown, or whose
method or scope differs from the request it claims to answer, is a protocol
error: it means the two sides disagree about what is in flight.

**`event`** — the worker reports something unsolicited. Events are never
acknowledged and carry no reply. An event `id` is for logging and deduplication,
not correlation.

Response payloads take one of two shapes, and no other:

```json
{ "ok": true, "result": { } }
```

```json
{ "ok": false, "error": { "code": "string", "message": "string", "details": { } } }
```

`result` and `details` are optional. `code` and `message` are required strings.

## 4. Session scope

Some work belongs to a conversation and some belongs to the worker. A method's
scope is fixed by this specification, and a frame that gets it wrong is rejected
(`invalid_session_scope`) rather than tolerated.

- **Scoped** frames carry `sessionId`. Omitting it is an error.
- **Global** frames must omit `sessionId` entirely. Sending `null` is still
  sending the field, and is an error.

### Requests

| Method | Scope | Meaning |
| --- | --- | --- |
| `worker.initialize` | global | Negotiate startup. Must be the first request. |
| `worker.shutdown` | global | Ask the worker to stop accepting work and exit. |
| `worker.activity` | global | Observe bounded ownership counters on the existing worker without starting a runtime or changing its activity revision. |
| `worker.admission` | global | Reversibly close or reopen admission using an exact fence identifier; does not cancel accepted work. |
| `models.catalog` | global | List models the worker can run. |
| `oauth.providers` | global | List providers that support interactive sign-in. |
| `oauth.status` | global | Report sign-in state. |
| `oauth.start` | global | Begin an interactive sign-in. |
| `oauth.submit` | global | Supply a code or credential to an attempt in progress. |
| `oauth.cancel` | global | Abandon an attempt in progress. |
| `session.start` | scoped | Create a conversation and run its first turn. |
| `session.resume` | scoped | Attach to a conversation that already exists. |
| `turn.start` | scoped | Run a turn in an existing conversation. |
| `turn.abort` | scoped | Stop the running turn. |
| `turn.steer` | scoped | Inject input into the running turn without ending it. |
| `goal.inspect` | scoped | Read the exact persisted provider session's goal for an authenticated owner and resolved project cwd; refuses an app-owned active run. Inspection uses read-only inventory and an SDK-validated immutable transcript snapshot, projecting only the current branch without constructing a session manager: it never recovers backups, rewrites the transcript, persists replay sanitation, or changes source sidecars or image blobs, including when an external CLI is still writing. |
| `goal.control` | scoped | Read or control a goal on the exact worker `runId`; requires matching app session, owner, cwd, and expected goal ID. The trusted server may pass literal `stopAfterMutation: false` for pause/drop so the enclosing native worktree job owns cancellation. |
| `ask.reply` | scoped | Answer a question the worker raised with `ask.presented`. |

### Events

| Method | Scope | Meaning |
| --- | --- | --- |
| `worker.status` | **optional** | Worker health or progress. Carries `sessionId` when it concerns one conversation, omits it when it concerns the worker. |
| `session.created` | scoped | A conversation now exists and has its identity. |
| `message.delta` | scoped | Additional assistant output. Deltas, not snapshots. |
| `message.completed` | scoped | An assistant message is final. |
| `tool.started` | scoped | A tool call began. |
| `tool.completed` | scoped | A tool call finished, with its result. |
| `ask.presented` | scoped | The worker needs an answer; reply with `ask.reply`. |
| `usage.updated` | scoped | Token or cost accounting changed. |
| `turn.completed` | scoped | The turn ended normally. |
| `turn.failed` | scoped | The turn ended in failure. |
| `oauth.phase` | global | An interactive sign-in changed phase. |
| `oauth.providers.updated` | global | The set of sign-in providers changed. |
| `provider.auth.updated` | global | Stored credentials changed. |

`worker.status` is the only method whose scope is optional, and it is deliberate:
the same event reports both "this worker is alive" and "this conversation is
still working".

## 5. Payload schemas

The envelope above is enforced strictly. **Most payload contents are not.** Except
for the two ownership methods specified below, a payload is checked for being a
valid JSON object and nothing more; what belongs inside
`session.start` or `tool.completed` is defined by the typed contract the two
reference implementations share, not by the protocol codec.

This is a real limitation, stated rather than hidden. A third party implementing
the **host** side can work from the frames a reference worker emits. A third
party implementing the **worker** side needs the payload schemas, and today those
live in the reference implementation's types.

Publishing them — as JSON Schema, or as a generated document — is the work that
would make this a complete two-sided specification. Until then, treat §1–§4 as
normative and payload shapes as observed behaviour.

### Ownership observations and admission

`worker.activity` accepts exactly `{}`. A successful result contains exactly
`generation`, `complete`, `starting`, `queued`, `running`, `settling`, `approvals`,
`retained`, `unknown`, and `fenceId`. The six counters are nonnegative safe
integers and may overlap; `complete` is boolean. `generation` and each entry in
`unknown` match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`. `unknown` has at most 32
entries. `fenceId` is null or an identifier matching the same pattern.
An empty counter set is not idle evidence when completeness is false, an unknown
reason is present, or the expected admission fence is absent.

`worker.admission` accepts exactly `{ "fenceId": "identifier", "closed": true }`
or the same shape with `closed: false`. A successful result contains only
`fenceId`: the accepted identifier when closing and null when reopening. Another
fence cannot replace or release the current fence. Accepted work and its necessary
completion callbacks remain owned; closing admission is not an abort request.
The reference host closes locally before awaiting the worker acknowledgement and
must release the exact fence after a failed/cancelled/expired restart preparation.
A late or failed release acknowledgement is not proof that admission reopened.
The host's common admission fence closes before this worker handshake; setup and
all activity reads share the original five-second preparation budget. A cancelled
or timed-out handshake retains cleanup ownership through its actual settlement
and the ordered release. Successful commit keeps worker admission closed.

The worker's generation binds its incarnation, host revision and SDK generation.
The first correlated observation under an acknowledged fence establishes the
host's remote baseline. A later changed generation permanently invalidates that
fence, even if counts return to zero. This is sampled evidence, not a substitute
for complete ownership and prevention of new internal work.

These payloads, including successful response results, are strictly validated by
the codec. Unknown fields, invalid counters, or a missing result are protocol
errors. Both methods operate on the existing worker; observation must not lazily
start one. Neither method grants permission to install or shut down the app.

## 6. Versioning

`protocolVersion` is `1`. A frame carrying any other value is rejected with
`unsupported_protocol_version` **before** anything else about it is examined.

There is no negotiation and no downgrade path: a host and a worker either agree
on the version or do not talk. This is why `worker.initialize` exists as the
first request — it fails fast and visibly when the two sides were built against
different versions, instead of failing later inside a turn.

A future version 2 is a new value of this field. It does not reuse version 1
frames with extra fields, because unknown fields are already rejected.

## 7. Errors

Two error channels, and they mean different things.

**Protocol errors** abort the connection. They carry a stable code and text that
is fixed by the implementation, never assembled from frame contents.

| Code | Raised when |
| --- | --- |
| `malformed_frame` | Not valid UTF-8 JSON. |
| `invalid_envelope` | Not an object, or `kind` is not one of the three. |
| `unsupported_protocol_version` | `protocolVersion` is not 1. |
| `unknown_field` | The envelope carries a field not in §2. |
| `unknown_method` | The method is not listed in §4. |
| `invalid_id` / `invalid_session_id` | An identifier fails the pattern in §2. |
| `invalid_session_scope` | A global frame carried `sessionId`, or a scoped one omitted it. |
| `invalid_payload` | The payload is not a plain object. |
| `invalid_json_value` | Non-finite number, circular reference, or a non-JSON value. |
| `invalid_response_payload` | The response is not one of the two shapes in §3. |
| `frame_too_large` | Any frame, line or buffer exceeds 64 MiB. |
| `invalid_ndjson` | A blank line appeared in the stream. |
| `unterminated_frame` | Input ended mid-frame. |
| `decoder_failed` | Input arrived after the decoder already failed. |
| `duplicate_request_id` | A second request reused an in-flight `id`. |
| `unknown_response_id` | A response matched no pending request. |
| `mismatched_response` | A response's method or scope differed from its request's. |
| `worker_exited` | The worker exited with requests still pending. |

**Application errors** are ordinary responses with `ok: false`. A model refusing,
a tool failing, a session not existing — all are successful protocol exchanges
reporting an unsuccessful outcome. Do not conflate the two: a protocol error
means the connection is no longer trustworthy, and an application error means it
is working exactly as intended.

## 8. Secret redaction

A host may hand the serializer a list of strings that must never appear on the
wire. Every frame is then walked before emission and each occurrence — in string
values **and in property names** — is replaced with `[redacted]`.

The serializer validates, redacts, and validates again before writing, so
redaction cannot produce a frame that would not have parsed.

This protects against a credential reaching a log through a diagnostic payload.
It is not a substitute for not putting credentials in payloads.

## 9. Lifecycle

```
host                                   worker
  │                                       │
  ├── request  worker.initialize ────────►│
  │◄───────────────────── response ───────┤
  │                                       │
  ├── request  session.start (sessionId) ►│
  │◄───── event session.created ──────────┤
  │◄───── event message.delta ×N ─────────┤
  │◄───── event tool.started / completed ─┤
  │◄───── event usage.updated ────────────┤
  │◄───── event turn.completed ───────────┤
  │◄───────────────────── response ───────┤
  │                                       │
  ├── request  worker.shutdown ──────────►│
  │◄───────────────────── response ───────┤
```

Rules a conforming implementation must hold:

1. `worker.initialize` precedes every other request.
2. A request's response may arrive after events that the request caused. A host
   that waits for the response before processing events will deadlock on any
   turn that asks a question.
3. `ask.presented` blocks the turn until the host sends `ask.reply` with the same
   session scope. A host that never replies leaves the turn hanging; a host that
   cannot answer should `turn.abort`.
4. Every terminal turn event — `turn.completed` or `turn.failed` — is emitted
   exactly once per turn, and never both.
5. When the worker exits, every pending request fails with `worker_exited`. A
   host must treat that as terminal for those requests, not retry them blindly.

## 10. Conformance

A **host** implementation must:

- reject frames failing §2 rather than best-effort parse them;
- correlate responses by `id`, verifying method and session scope;
- tolerate events arriving before the response to the request that caused them;
- fail pending requests when the stream closes.

A **worker** implementation must:

- emit exactly one response per request, matching id, method and scope;
- keep non-protocol output off the frame stream;
- emit exactly one terminal event per turn;
- never emit a scoped frame for a session that has not been created.
