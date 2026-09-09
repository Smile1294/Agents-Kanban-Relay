# Relay protocol — v3

The relay carries the extension's **own board webview** over an asynchronous
transport. The extension pushes the frames it would post to that webview; the
page queues the messages that webview would post back. There is no second UI
code path — the page is `media/board.js` verbatim behind a small bridge.

The authoritative, machine-checked copy of these rules is
[`remote-contract.json`](../remote-contract.json), carried byte-for-byte in the
extension repo. This file is the human-readable version of the relay-facing
half of it.

## The contract

```json
{
  "version": 3,
  "payload": "…",
  "idOk": "^[0-9a-f]{24}$",
  "nonceOk": "^[A-Za-z0-9._-]{1,64}$",
  "typeOk": "^[A-Za-z][A-Za-z0-9._-]{0,39}$",
  "msgMax": 40,
  "msgMaxBytes": 4000000,
  "frameMaxBytes": 4000000,
  "eventsMax": 50,
  "deltasMax": 40,
  "fnPath": "/board"
}
```

Every host serves one API at `fnPath` (`/board`). A board's address is the
first 24 hex chars of the sha-256 of its pairing code; possession of the id is
read **and** write (writes travel with the id as `x-rc-key`). The constants in
`remote-contract.json` are enforced in `functions/board-core.mjs` as `ID_OK`,
`NONCE_OK`, `TYPE_OK`, `MSG_MAX`, `MSG_MAX_BYTES`, `FRAME_MAX_BYTES`,
`EVENTS_MAX` and `FN_PATH`.

## Storage (per board id, in the injected store)

| blob | content |
|---|---|
| `s:<id>` | the clock: `{ seq, at, writes, mv, viewerAt, frameSeq }`. `seq` is a monotonic counter bumped by every frame-with-state and every event. Read it FIRST on every GET — it is small. |
| `f:<id>` | the latest frame: `{ seq, frame }`, `frame` = `{ type:'state', state }` — as pushed, or COMPOSED from the patches since (the extension has already removed `state.composer.models`). Always a complete board. |
| `d:<id>` | a ring of frame patches `[{ seq, base, patch }]`, at most `deltasMax`, oldest dropped, cleared by any whole state. |
| `m:<id>` | the model catalogue: `{ mv, models }`. |
| `e:<id>` | a ring of host→page events `[{ seq, msg }]`, at most `eventsMax`, oldest dropped. |
| `q:<id>` | the queue of page→host messages `[{ nonce, at, msg }]`, at most `msgMax`, FIFO. |

## POST kinds

- `{ kind:'frame', at, writes, mv, state?, patch?, models? }` — if `state`
  present: store `f:` with `seq+1`, set `frameSeq`, and DELETE `d:` (every
  retained patch describes a chain that no longer leads anywhere). If `patch`
  present instead: compose it onto `f:` and store the result the same way, and
  append `{ seq, base, patch }` to `d:`. If `models` present: store `m:` =
  `{ mv, models }`. Always update `at`, `writes` (boolean), `mv` (string, may be
  `''`). Refuse a body whose JSON text exceeds `frameMaxBytes` with 413. Answer
  `{ ok:true, patches:true, frameSeq, mv, viewerAt, msgs:[...pending] }` — the
  pending messages so a busy board picks them up on its own pushes, `frameSeq`
  so the pusher knows the base for its next patch, and `patches:true` so it
  learns this relay understands them at all.
- `{ kind:'event', events:[msg, ...] }` — each `msg` is an object whose `type`
  matches `typeOk`; append each with `seq+1`; keep at most `eventsMax`. Answer
  `{ ok:true, seq }`.
- `{ kind:'msg', nonce, msg }` — `nonce` matches `nonceOk`; `msg` is an object;
  `msg.type` matches `typeOk`; `JSON.stringify(body).length <= msgMaxBytes`
  (413 otherwise); the same nonce already queued → `{ ok:true }` (a retry, not
  a duplicate); queue full → 429; else push `{ nonce, at: now, msg }`. Answer
  `{ ok:true }`.
- `{ kind:'ack', nonces[] }` — remove those nonces (each must match `nonceOk`).
  Acking is the only way a message leaves the queue; delivery is at-least-once.
- Any other `kind` — including the OLD `update` and `command` — → 400 with
  `this relay speaks contract v2 — update the extension`.

Whether a queued message RUNS is the extension's decision (`remote.writes`),
never the relay's. The relay only holds them.

## GET

- `?id=X` (no `since`) → `{ ok, seq, at, writes, mv, frame (or null), events: [] }`;
  404 `{ ok:false, error }` when `s:` does not exist yet.
- `?id=X&since=N` → read `s:`; if `seq === N` → `{ ok, seq, at, writes, mv,
  events: [] }` WITHOUT reading the frame blob (the cheap poll). Otherwise
  include `frame` only if `frameSeq > N`, and `events` with `seq > N`; if `N`
  is older than the oldest retained event, return everything retained and add
  `gap: true`. A GET with `since` counts as viewer presence: update `viewerAt`
  in `s:`, but at most once per 20 s.
- `&d=1` says the caller can apply frame patches. Then, when `frameSeq > N`,
  `deltas` (the patches from `d:` with `seq > N`, oldest first) is returned
  INSTEAD of `frame` — but only when the chain reaches the caller's cursor,
  which is `ring[start].base <= N` for the first entry newer than `N`: that
  patch's base frame is one the caller has already seen, and the entries after
  it are chained to it. Otherwise the whole `frame` goes, as it always did.
  Never on a first load (no `since`): there is nothing to apply a patch to.

## Frame patches

97% of a frame is the transcript, and it barely changes. Measured on a
realistic board — 14 cards, a review panel, a full composer:

| transcript | frame | of which transcript | everything else |
|---|---|---|---|
| 400 rows | 282 KB | 97.3% | 7.6 KB |
| 100 rows | 76 KB | 90.1% | 7.6 KB |

At one push per 2 s that was **8.7 MB a minute** out of the pushing machine and
the same into every watching phone, to re-send a conversation that is almost
entirely immutable — Claude Code fixes history when a run starts and only
appends after it, the same property `media/board.js` already relies on for its
own fast path.

So a push may carry `patch` instead of `state`:

```json
{ "base": 12, "state": { "…the board without its transcript…" },
  "rows": { "from": 399, "rows": ["…only what changed…"] } }
```

`state` is the whole board MINUS `transcript`, sent in full every time —
diffing 7.6 KB generically would buy 3% and cost a merge algorithm that can be
wrong in ways nobody would notice. `rows` replaces the transcript from `from`
onwards, and is absent when the transcript did not move at all. `base` is the
`frameSeq` the patch applies to.

Measured over real HTTP, one row arriving on a 400-row board: **538 bytes
against 146,018** for the same frame. End to end in a browser against the Node
host, six seconds of a streaming agent on a 200-row board: the four updates
cost **16.6 KB instead of 526 KB**, and the pushing machine posted **145 KB
instead of 655 KB**.

Four things are load-bearing:

- **The relay COMPOSES, it does not only log.** `f:` is always a complete
  board, so a page joining mid-stream — or one that has fallen past
  `deltasMax` — is handed a whole frame. There is no state in which the relay
  can only offer fragments a caller cannot place.
- **A patch is REFUSABLE.** `base` must be the frame the relay is actually
  holding and the splice must not leave a gap; otherwise the answer carries
  `needFrame: true`, nothing is stored, `seq` does not move, and the pusher
  sends a whole state next. An end that silently mis-applied a patch would
  show a transcript that is subtly not the board's, which is worse than
  sending 282 KB.
- **Both ends OPT IN, neither assumes.** `patches: true` on the answer is how
  a pusher learns the relay speaks v3 — a v2 relay handed a patch would store
  nothing and the board would silently stop moving. `&d=1` is how a page says
  it can apply one — a page built against v2 never receives one.
- **The transcript's PRESENCE changing falls back to a whole state**, as do a
  session switch and upward pagination. `rows` can say "these rows changed",
  not "there is no transcript now", and inventing an encoding for a case that
  happens on a click rather than on a token is how a format grows a corner
  nobody tests.
- `?id=X&models=1` → `{ ok, mv, models }` (404 when none).
- `?id=X&msgs=1[&wait=<secs>]` → `{ ok, msgs, viewerAt }`. With `wait`, a host
  that can hold a request holds it until the queue is non-empty or the timeout,
  so a pushing machine learns of a queued message AS IT LANDS rather than at its
  next tick. Measured end to end, tap on the phone to the board moving: that
  interval was one of two 0–2000 ms waits either side of ~70 ms of actual work,
  and removing both took the round trip from 370–2729 ms to a ~45 ms median.
  Every GET answer from such a host carries `longPoll: true`, and a caller must
  never assume holding without it — a host that answers immediately, looped on,
  is a busy loop against the relay.
- `&wait=<secs>` (1..25): only the plain Node host honours it — hold the
  response until `seq` changes or the timeout, via an in-process emitter fired
  on every store mutation; every GET answer from that host carries
  `longPoll: true` so the page may loop immediately. Netlify and the Worker
  ignore `wait`.

## Hosts

| Host | Store | `wait` / `longPoll` |
|---|---|---|
| `server.js` (Node) | one JSON file, serialised atomic writes | honours `wait` on board AND `msgs` polls; every GET carries `longPoll:true` |
| `functions/board.mjs` (Netlify) | Netlify Blobs (`getStore`, site-wide) | ignores `wait`; no `longPoll` |
| `worker.js` (Cloudflare) | Workers KV | ignores `wait`; no `longPoll` |

**A held request never holds the lock.** `handle()` serialises per board id, so
a poll that kept that lock while waiting would block every write to the same
board for the whole 25 s — the exact opposite of what holding it is for. Both
holds call `handle()`, let the lock go, and only then wait; `tests/server.test.mjs`
pushes a frame to a board that has a poll held open on it and asserts the push
is not delayed.

**Concurrency.** Every branch above is a read-modify-write across `await`
points — read the clock, bump `seq`, write it back — so `handle()` serialises
per BOARD id (`functions/board-core.mjs`). Interleaved requests otherwise lose
queue entries and collide `seq`, and a colliding `seq` files a frame under a
number a watching page has already passed: that page never sees the frame. The
mutex is in-process, so it is a real guarantee on the Node host (the recommended
one, and the only one that long-polls) and best-effort on Netlify and the
Worker, which run many instances. Per board rather than global so one board's
write cannot hold up another's poll. Measured before it existed: 200 concurrent
posts to one board, 3 answered `200`, 40 in the queue.

`functions/board.mjs`, `worker.js` and `server.js` all pass `d` through to
`handle()` alongside `since`, `wait`, `models` and `msgs`.

`server.js` bounds the request body at `BODY_MAX` (5 MB — a message may carry
images) and serves a static whitelist that includes `/media/board.js`,
`/media/board.css`, `/media/theme.css`, `/bridge.js` and `/bridge.css`.
`functions/board.mjs` and `worker.js` pass `since`, `wait`, `models` and `msgs`
through to `handle()`. `wrangler.toml` and `netlify.toml` are unchanged from the
layout they already describe.

> Cloudflare KV's free tier (1,000 writes/day) cannot carry a live board — a
> frame every 2 s while an agent streams blows past it in minutes. Patches make
> each write far SMALLER but add one more per push (the ring alongside the frame
> and the clock), so they do not change that advice: KV's limit is on the count,
> not the size. Recommend the plain Node host (true long-poll streaming) or
> Netlify.

## The page (`public/`)

The page is the extension's own board, carried verbatim: `scripts/sync-media.mjs`
copies `media/board.js`, `media/board.css` and `media/theme.css` from the
extension repo into `public/media/` (byte-for-byte; re-run it after the
extension's `media/` changes). `public/index.html` loads them behind
`public/bridge.js`, which swaps the webview's transport for the relay's:

- **Pairing** — the code is typed once; `id = sha-256(code)` hex cut to 24
  chars via `crypto.subtle`; only `{ id }` is kept in `localStorage` under
  `agents-kanban.remote`; `#<24hex>` in the URL hash pairs a new device.
- **`acquireVsCodeApi()`** — `postMessage(msg)` becomes `POST /board`
  `{ kind:'msg', nonce: crypto.randomUUID(), msg }`, gated on `msgMaxBytes` and
  on the last envelope's `writes` flag.
- **Polling** — `GET /board?id=<id>&since=<seq>`, adding `&d=1` once it holds a
  board to apply patches to, and `&wait=25` when the last answer had
  `longPoll: true`; otherwise 2 s while fresh, 15 s quiet, 60 s after 10 minutes
  quiet, 15 s after an error. On each answer, a new `mv` (or the first frame of
  the page life) triggers `?models=1` first, `deltas` are composed onto the
  board the page holds (`applyPatch`, the mirror of the relay's
  `composePatch`), the catalogue is injected into `state.composer.models`, and
  the WHOLE state is dispatched as a `window` message — exactly the shape the
  webview expects. `board.js` is the extension's own file carried byte-for-byte
  and never learns that the transport got cleverer; a patch it cannot place
  drops the cursor so the next poll returns the whole board, rather than
  rendering a guess.
- **Editor-only actions** (`openSettings`, `focus`, `openBoard`, `closeBoard`,
  `openFolder`) are intercepted and toast; `voiceStart`/`voiceStop` drive
  browser dictation (the transcript arrives later as a `voice` event).
- **`{ type:'remote', kind }`** events never reach board.js: `kind:'dialog'`
  draws an overlay, `kind:'toast'` a toast.
- **Status chrome** — a fixed strip: a live age pill, a READ-ONLY badge when
  `writes === false`, *Forget this board*, and the relay error text.

There is no `innerHTML` anywhere in `public/` — nodes and text only.

## Dev tooling

`scripts/fake-extension.mjs` stands in for the extension so the page can be
tried without VS Code:

```bash
node scripts/fake-extension.mjs <relayUrl> <pairingCode> [--read-only]
```

It derives the id, pushes a sample frame (`scripts/sample-frame.json`) plus a
model catalogue, then loops: polls `?msgs=1`, prints and acks each queued
message, and answers a few plausibly — `select` re-pushes the frame in chat
mode, `search` posts a `searchResults` event, `voiceAudio` posts a `voice`
event, `remove` posts a `remote` dialog event and prints the answer.
