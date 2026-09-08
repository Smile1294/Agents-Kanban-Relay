# Agents Kanban — remote board relay

The relay carries the extension's **own board** to any browser: the sessions
rail, the kanban columns, the chat panel with the complete composer, the review
panel — the exact webview the VS Code panel shows, live. It is not a redacted
mirror; it is the board itself, pushed over an asynchronous transport.

> You also need the **extension** that pushes to this relay:
> [Agents-Kanban](https://github.com/Smile1294/Agents-Kanban). This relay
> relays a board that runs on another machine — it does not run agents itself.
> If what you want is a board you drive *on a box of your own*, see the
> *headless board* in that repo (`server/README.md`): it runs the extension
> itself on the box.

This repository is the relay, lifted out of the Agents-Kanban extension repo:
self-contained, and deployable as is on any of the three hosts below. Nothing
here runs on your machine unless you run it there on purpose.

## What the page is

The page is `media/board.js` — the extension's own webview script — copied
verbatim and served behind a small bridge that swaps its transport for the
relay's. Every control works exactly as it does in VS Code: switching
kanban/chat, the model / agent / backend / orchestration / effort / `Extended`
thinking pickers, permission answering, transcript search, merge, commit, the
review panel, drag-and-drop phase moves. Two kinds of control are special on a
remote page:

- **Editor-only actions** (`Open worktree`, `Open folder`, `Focus`, `Open
  settings`…) toast — *that happens on the board's machine* — instead of
  driving an editor the page does not have.
- **Actions** (send a message, select a session, answer a permission, merge,
  archive, delete…) are queued to the pushing machine and run there only while
  the extension's **Remote Control → "Allow actions from the remote page"**
  switch is on. While it is off the page shows a **READ-ONLY** badge and drops
  every action with a toast; it can still watch the board live.

Known and accepted: the remote page is a second mirror of the SAME panel
surface, so selecting a session or switching kanban/chat remotely also changes
the local VS Code panel. The settings surface is not carried; its gear button
toasts.

## Pick a host

All three serve the same API at the same path (`<site>/board`) and the same
page; they differ only in where the store lives and what "deploy" means.

| Host | Store | What you need | Notes |
|---|---|---|---|
| **Netlify** (functions) | Netlify Blobs | a Netlify account | The original target. |
| **Cloudflare Workers** | Workers KV | a Cloudflare account + wrangler | KV's free tier (1,000 writes/day) **cannot** carry a live board — see below. |
| **Any Node server** | one JSON file in `data/` | any box with Node 22+ | No account at all; the only host that does true long-poll streaming. **Recommended for a live board.** |

Same behaviour on all three: the relay logic is one file
(`functions/board-core.mjs`) and the host files are thin adapters around it.

> **Host recommendation.** A live board pushes a frame every 2 seconds while an
> agent streams. Cloudflare KV's free tier caps writes at 1,000/day, so a single
> busy session blows past it in minutes. For a board you watch live, use the
> **plain Node host** (it honours `wait`, holding each poll open until the board
> changes — true streaming) or **Netlify**. KV is fine for an occasionally
> checked, mostly-idle board.

### Netlify

1. Push this repository to your account (it is ready to deploy).
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

1. Create the KV namespace and put its id into `wrangler.toml` where it says
   `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`:

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
store). Put it behind whatever you already use — a reverse proxy, a `systemd`
unit, a free-tier VPS. To reach it from other devices, the port must be
reachable from those networks.

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

## How the privacy works

- The relay stores **nothing secret**. A board's address is the first 24 hex
  chars of the sha-256 of your pairing code (~96 bits) — the relay never sees
  the code, so it cannot be robbed for it. The pairing code never leaves your
  machine.
- The page shows nothing until a code is entered, and only the board that code
  derives is reachable. There is no list of boards and no login to expire or
  be phished.
- **What travels changed with v2.** The old relay pushed a redacted card index;
  this one pushes the board itself, so worktree paths, branch names, tool
  *summaries* (a Bash row summarises as its command), review file lists and
  test-plan links now travel to the relay. This is a deliberate, accepted
  trade for a full, live board. Provider credentials never appear — `UiState`
  carries no keys, only `hasCredential` flags.
- Messages only ever flow back while the extension's
  **"Allow actions from the remote page"** switch is on, and what runs is the
  extension's decision, never the relay's. The queue is bounded (`msgMax` 40
  entries, `msgMaxBytes` 4 MB each), so a holder of the code cannot bloat the
  relay.

## Keep the page in sync

The page **is** the extension's board, so its three assets are carried
byte-for-byte rather than re-implemented. After the extension's `media/`
changes, re-copy them:

```bash
node scripts/sync-media.mjs                 # from the sibling ../Agents-Kanban
node scripts/sync-media.mjs /path/to/Agents-Kanban   # explicit checkout
```

Commit the copies. `tests/media-sync.test.mjs` fails if they drift (or skips
loudly when no extension checkout is next to this one).

## Try it without VS Code

`scripts/fake-extension.mjs` stands in for the extension, so the page can be
tried end to end on your own machine:

```bash
node server.js                                    # terminal 1
node scripts/fake-extension.mjs http://localhost:8787 test-code   # terminal 2
```

Then open `http://localhost:8787` and enter `test-code`. The fake pushes the
sample board (`scripts/sample-frame.json`) and a model catalogue, and answers a
few messages so the page is live rather than a snapshot: clicking a card opens
the chat view, a search returns a result, and removing a session raises a
confirmation dialog. Add `--read-only` to push `writes: false` and see the
READ-ONLY badge and the dropped-post toast.

## Layout

| Path | What it is |
|---|---|
| `functions/board-core.mjs` | The relay's logic with the store injected — the file every host and every test wraps |
| `functions/board.mjs` | The Netlify function (thin wrapper over `board-core.mjs`) |
| `worker.js` | The Cloudflare worker (KV store adapter around `board-core.mjs`) |
| `server.js` | The plain-Node server (file-backed store around `board-core.mjs`) — zero dependencies, the long-poll host |
| `wrangler.toml` / `netlify.toml` | Workers / Netlify config: assets, the `/board` route |
| `public/index.html` | The page's document: CSP, theme → board → bridge stylesheets, then the two scripts |
| `public/bridge.js` | The webview bridge — `acquireVsCodeApi`, pairing, polling, dialogs, toasts, dictation, status chrome |
| `public/bridge.css` | The bridge's gate, overlays, toasts and status strip |
| `public/media/` | `board.js` / `board.css` / `theme.css`, byte-identical copies of the extension's assets (see *Keep the page in sync*) |
| `scripts/sync-media.mjs` | Copies the extension's three `media/` files into `public/media/` |
| `scripts/fake-extension.mjs` | A stand-in extension for trying the page without VS Code |
| `scripts/sample-frame.json` | The sample `UiState` the fake extension pushes |
| `docs/protocol.md` | The relay-facing half of the spec, in prose |
| `remote-contract.json` | The shared rules, carried verbatim in the extension repo |
| `tests/` | The suite — plain `node tests/<x>.test.mjs`, run by `npm test` |
| `tests/dom.mjs` | A full copy of the extension repo's `test/dom.mjs` (see below) |

## Testing

`npm test` runs the suite as plain Node — no framework; each file prints
`ok:` / `FAIL:` lines and exits non-zero on a failure — and rides the
`node --check` syntax gates of the deployables along.

- `tests/handler.test.mjs` — `board-core.mjs` against a fake blob store: the
  write gate, the storage names, the monotonic clock, replace-not-merge, the
  event ring, the message queue, and every GET shape.
- `tests/worker.test.mjs` — the Cloudflare worker against a fake KV: the list
  mapping, the routing guard, and the new query params.
- `tests/server.test.mjs` — the real Node server, spawned on an ephemeral port
  with a throwaway data directory, driven over real HTTP: the static routes,
  the 5 MB body bound, true long-poll, and concurrency — that no simultaneous
  write answers 5xx, that the queue holds exactly its cap rather than whichever
  writes won, and that N concurrent events advance `seq` by exactly N, on one
  board and across several sharing the store file.
- `tests/contract.test.mjs` — this copy of `remote-contract.json` agrees with
  `board-core.mjs`'s constants and with the `/board` route the hosts serve.
- `tests/media-sync.test.mjs` — the three `public/media/` assets are
  byte-identical to the extension's, or a loud `UNCHECKED` skip when no
  extension checkout is next to this one.
- `tests/bridge.test.mjs` — `public/bridge.js` then the real
  `public/media/board.js` in one shared DOM: the gate, frame dispatch, the
  composer chips, the message queue, the READ-ONLY badge, remote dialogs, the
  oversize guard, and that an action the relay refuses SAYS so — retried once on
  a 5xx or a dropped connection (the nonce makes that idempotent), never on a
  4xx, and a full queue named as the board not draining it.

`tests/dom.mjs` is a full copy of the extension repo's `test/dom.mjs` — the
stub DOM the extension's own webviews run against. When the extension's copy
grows, mirror the change here by hand.

The **contract**: `remote-contract.json` at this repository's root is carried
VERBATIM in the extension repo (`Agents-Kanban`). The extension's verify gate
(`scripts/check-contract.mjs`) compares the two copies and checks the
extension's own duplicated constants (`NONCE_OK`, `TYPE_OK`, `MSG_MAX_BYTES`,
the `/board` path) against it. Change a rule here and the extension's gate goes
red until both ends agree.

## Credits and licence

MIT — see the extension repo's [LICENSE](https://github.com/Smile1294/Agents-Kanban/blob/main/LICENSE).
