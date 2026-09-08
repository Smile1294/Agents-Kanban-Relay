# Relay protocol — v2

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
  "version": 2,
  "payload": "…",
  "idOk": "^[0-9a-f]{24}$",
  "nonceOk": "^[A-Za-z0-9._-]{1,64}$",
  "typeOk": "^[A-Za-z][A-Za-z0-9._-]{0,39}$",
  "msgMax": 40,
  "msgMaxBytes": 4000000,
  "frameMaxBytes": 4000000,
  "eventsMax": 50,
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
| `f:<id>` | the latest frame: `{ seq, frame }`, `frame` = `{ type:'state', state }` exactly as pushed (the extension has already removed `state.composer.models`). |
| `m:<id>` | the model catalogue: `{ mv, models }`. |
| `e:<id>` | a ring of host→page events `[{ seq, msg }]`, at most `eventsMax`, oldest dropped. |
| `q:<id>` | the queue of page→host messages `[{ nonce, at, msg }]`, at most `msgMax`, FIFO. |

## POST kinds

- `{ kind:'frame', at, writes, mv, state?, models? }` — if `state` present:
  store `f:` with `seq+1` and set `frameSeq`; if `models` present: store `m:` =
  `{ mv, models }`; always update `at`, `writes` (boolean), `mv` (string, may be
  `''`). Refuse a body whose JSON text exceeds `frameMaxBytes` with 413. Answer
  `{ ok:true, mv, viewerAt, msgs:[...pending] }` so a busy board picks up
  messages on its own pushes.
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
- `?id=X&models=1` → `{ ok, mv, models }` (404 when none).
- `?id=X&msgs=1` → `{ ok, msgs, viewerAt }`.
- `&wait=<secs>` (1..25): only the plain Node host honours it — hold the
  response until `seq` changes or the timeout, via an in-process emitter fired
  on every store mutation; every GET answer from that host carries
  `longPoll: true` so the page may loop immediately. Netlify and the Worker
  ignore `wait`.

## Hosts

| Host | Store | `wait` / `longPoll` |
|---|---|---|
| `server.js` (Node) | one JSON file, atomic writes | honours `wait`; every GET carries `longPoll:true` |
| `functions/board.mjs` (Netlify) | Netlify Blobs (`getStore`, site-wide) | ignores `wait`; no `longPoll` |
| `worker.js` (Cloudflare) | Workers KV | ignores `wait`; no `longPoll` |

`server.js` bounds the request body at `BODY_MAX` (5 MB — a message may carry
images) and serves a static whitelist that includes `/media/board.js`,
`/media/board.css`, `/media/theme.css`, `/bridge.js` and `/bridge.css`.
`functions/board.mjs` and `worker.js` pass `since`, `wait`, `models` and `msgs`
through to `handle()`. `wrangler.toml` and `netlify.toml` are unchanged from the
layout they already describe.

> Cloudflare KV's free tier (1,000 writes/day) cannot carry a live board — a
> frame every 2 s while an agent streams blows past it in minutes. Recommend
> the plain Node host (true long-poll streaming) or Netlify.

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
- **Polling** — `GET /board?id=<id>&since=<seq>`, adding `&wait=25` when the
  last answer had `longPoll: true`; otherwise 2 s while fresh, 15 s quiet, 60 s
  after 10 minutes quiet, 15 s after an error. On each answer, a new `mv` (or
  the first frame of the page life) triggers `?models=1` first, the catalogue is
  injected into `frame.state.composer.models`, and the frame is dispatched as a
  `window` message — exactly the shape the webview expects.
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
