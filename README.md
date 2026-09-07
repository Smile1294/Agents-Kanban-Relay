# Agents Kanban — remote board relay

The **mirror mode** of Remote Control: a small site that receives a board —
cards, phases and the chats — pushed from an Agents Kanban install, and shows
it in any browser. No code, no file paths and no credentials ever leave the
machine pushing.

> You also need the **extension** that pushes to this relay:
> [Agents-Kanban](https://github.com/Smile1294/Agents-Kanban). Or, if what you
> want is a board you can **drive from a browser on a box of your own** — send
> prompts, start sessions, approve, review, merge — see the *headless board*
> in that repo ([server/README.md](https://github.com/Smile1294/Agents-Kanban/blob/main/server/README.md)):
> it runs the extension itself on the box. This relay mirrors a board that runs
> elsewhere; it cannot run agents.

This repository is the relay, lifted out of the Agents-Kanban extension repo:
self-contained, and deployable as is on any of the three hosts below. Nothing
here runs on your machine unless you run it there on purpose.

The relay can also queue **prompts back to the board** (the write channel):
the watcher page can send a prompt into a session's chat or start a new
session. Whether such a prompt runs is decided by the extension, not by the
relay — see [The write channel](#the-write-channel).

## Pick a host

All three serve the same API at the same path (`<site>/board`) and the same
page; they differ only in where the store lives and what "deploy" means.

| Host | Store | What you need | Notes |
|---|---|---|---|
| **Netlify** (functions) | Netlify Blobs | a Netlify account | The original target. Free tier covers ordinary use. |
| **Cloudflare Workers** | Workers KV | a Cloudflare account + wrangler | Free tier covers ordinary use. |
| **Any Node server** | one JSON file in `data/` | any box with Node 22+ | No account at all — also the fastest way to try it locally. |

Same behaviour on all three: the relay logic is one file
(`functions/board-core.mjs`) and the host files are thin adapters around it.

### Netlify

1. Push this repository to your account (it is ready to deploy), or keep it
   local for the Node-server host.
2. On Netlify: **Add new site → Import an existing project**, or from a
   terminal in this folder:

   ```bash
   npm install
   npx netlify-cli deploy --prod
   ```

   The build installs `@netlify/blobs` and the function
   (`functions/board.mjs`) is discovered automatically; `public/` is the site,
   and `netlify.toml` rewrites `/board` to the function.
3. Note your site URL, e.g. `https://your-board.netlify.app`.

### Cloudflare Workers

1. Create the KV namespace the relay stores into, and put its id into
   `wrangler.toml` where it says `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`:

   ```bash
   npx wrangler kv namespace create BOARDS
   ```

2. Deploy from a terminal in this folder:

   ```bash
   npx wrangler deploy
   ```

   `wrangler.toml` serves `public/` as Static Assets and runs the worker only
   for `/board`.
3. Your site URL is `https://<worker-name>.<your-account>.workers.dev`.

### Any Node server (or your own machine)

The whole relay is one zero-dependency file:

```bash
node server.js
# PORT=8080 RC_DATA=/srv/board node server.js   # port and store location
```

It serves the page and the API on that port, and keeps the board in
`data/store.json` (written atomically, so a crash cannot leave a half-written
store). Put it behind whatever you already use — a reverse proxy, a
`systemd` unit, a free-tier VPS. To reach it from other devices, the port
must be reachable from those networks.

## Pair it with the extension

1. In Agents Kanban: open the **settings page → Remote Control**.
2. Paste the relay URL into *Relay site*.
3. Choose a **pairing code** — any string, like a password — and type it into
   the *Pairing code* field. The same code opens the board on any device that
   watches it; the code itself is stored only in your keychain, never here.
4. Press **Save and connect**. The board starts pushing within seconds.

To watch from a phone or another computer, open the site and enter the same
pairing code. It is remembered in that browser until you press *Forget this
board*.

## The write channel

By default the relay is a mirror. The settings page's Remote Control section
has a second, separate switch: **Allow prompts from the remote page**, default
OFF. While it is on:

- the watcher page shows a composer — one under each open chat, one to start
  a new session;
- a prompt sent from it is queued on the relay and picked up by the extension
  within ~30 seconds (sooner while the board is busy);
- the extension runs it exactly like a prompt typed locally: it lands in the
  session's chat or starts a new session, through the same permission, model
  and worktree paths the local webview uses;
- the extension acts, then confirms — the relay forgets a command only after
  the extension has run it. That is at-least-once: if the extension dies
  between running a command and confirming it, the next delivery may run it
  once more. The window is the extension's own crash, the standard queue
  trade.

What the switch is *for*: the pairing code is one capability, and possession
of it means possession of the mirror. Running prompts on the board's machine
is a deliberately separate capability because the consequences are different —
a junked mirror is disposable; a prompt can start sessions and spend tokens.
So:

- the relay only **queues** commands — it never decides one runs;
- the **extension** is the gate (`remote.writes`), and the composer on the
  page appears exactly while the extension says the channel is on;
- commands sent while the channel is off are **discarded when it is turned
  on**, never run late — "only commands sent while the switch is on ever run";
- the queue is bounded (20 commands, 20 000 characters each), so a holder of
  the code cannot bloat the relay.

## How the privacy works

- The relay stores **nothing secret**. A board's address is the first 24 hex
  chars of the sha-256 of your pairing code (~96 bits) — the relay never sees
  the code, so it cannot be robbed for it.
- The page shows nothing until a code is entered, and only the board that code
  derives is reachable. There is no list of boards and no login to expire or
  be phished.
- What leaves the extension is pinned by types and tests: cards (title, phase,
  tags, what the agent is doing — a tool *name*, never a command), and chat
  rows. Tool rows are stripped of their summaries because a summary is derived
  from the tool's input — a Bash row summarises as its command. Sessions are
  capped at their last 120 rows.
- Nothing ever flows the other way until you switch the write channel on. What
  flows then is data **you** typed — prompts, not board state — and it lands in
  the chat on your machine, in view of the redaction the next push applies
  like any other prompt.

## What the free tiers cover

A quiet board pushes only its heartbeat (at most every 90 seconds) and the
page polls slowly when nothing is moving, so ordinary use is a few thousand
relay calls a month — comfortably inside Netlify's or Cloudflare's free tier.
A board with agents running pushes on every change (never more often than
every 2 seconds, only while content actually changed), and a page left open
while that is happening polls fast; when the board goes quiet it slows back
down. Commands are picked up on pushes the board makes anyway, or on one poll
every 30 seconds while the write channel is on.

## Layout

| Path | What it is |
|---|---|
| `functions/board-core.mjs` | The relay's logic with the store injected — the file every host and every test wraps |
| `functions/board.mjs` | The Netlify function (thin wrapper over `board-core.mjs`) |
| `worker.js` | The Cloudflare worker (KV store adapter around `board-core.mjs`) |
| `server.js` | The plain-Node server (file-backed store around `board-core.mjs`) — zero dependencies |
| `wrangler.toml` | Workers config: assets, KV binding |
| `netlify.toml` | Function and publish directories, the `/board` rewrite |
| `public/` | The static viewer page (no build step, no framework) |
| `tests/` | The suite — plain `node tests/<x>.test.mjs`, run by `npm test` |
| `tests/dom.mjs` | A trimmed copy of the extension repo's `test/dom.mjs` (see below) |
| `remote-contract.json` | The shared rules, carried verbatim in the extension repo (see below) |

## Testing

`npm test` runs the suite as plain Node — no framework; each file prints
`ok:` / `FAIL:` lines and exits non-zero on a failure — and rides the
`node --check` syntax gates of the deployables along.

- `tests/handler.test.mjs` — `board-core.mjs` against a fake blob store: the
  write gate, the storage names, replacement-not-merge, the orphan-tail GC.
- `tests/worker.test.mjs` — the Cloudflare worker against a fake KV.
- `tests/server.test.mjs` — the real Node server, spawned on an ephemeral port
  with a throwaway data directory, driven over real HTTP.
- `tests/viewer.test.mjs` — `public/board.js` in a stub DOM: the page must
  never render the text "undefined".
- `tests/contract.test.mjs` — this copy of `remote-contract.json` agrees with
  `board-core.mjs`'s constants and with the `/board` route the hosts serve.

`tests/dom.mjs` is a trimmed copy of the extension repo's `test/dom.mjs` — the
stub DOM the extension's own webviews run against. When the extension's copy
grows, mirror the change here by hand.

The **contract**: `remote-contract.json` at this repository's root is carried
VERBATIM in the extension repo (`Agents-Kanban`). The extension's `verify` gate
(`scripts/check-contract.mjs`) compares the two copies — the sibling directory
first, then a hosted copy — and checks the extension's own duplicated
constants (`KEY_OK`, `NONCE_OK`, `CMD_TEXT_MAX`, the `/board` path) against it.
Change a rule here and the extension's gate goes red until both ends agree.

## Credits and licence

MIT — see the extension repo's [LICENSE](https://github.com/Smile1294/Agents-Kanban/blob/main/LICENSE).
