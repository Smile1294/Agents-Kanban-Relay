/* The relay as a plain Node server — any VPS, any self-hosted box, or just
 * your own machine for testing. Zero dependencies, Node 22+.
 *
 * The whole relay is one file and one JSON store:
 *
 *   node server.js                     # serves http://localhost:8787
 *   PORT=8080 RC_DATA=/srv/board node server.js
 *
 * - The static page (public/) is served from the site root.
 * - The relay API is at /board, the same path every host serves.
 * - The store is data/store.json, written atomically (temp file + rename), so
 *   a crash mid-write cannot leave a half-written blob that wedges the relay
 *   (board-core reads a broken queue as empty, but a broken store file would
 *   take the whole board with it — hence the rename).
 *
 * All behaviour lives in functions/board-core.mjs; this file is a store and a
 * transport, nothing more. Same rules as the other hosts: no stored secret,
 * the board address is the id derived from the pairing code, and commands are
 * only QUEUED here — whether they run is the extension's decision.
 */
import { createServer } from 'node:http'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handle } from './functions/board-core.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
// PORT=0 picks an ephemeral port (the tests use this), so the fallback must
// trigger on an ABSENT variable, not a falsy one — `|| 8787` read `0` as
// unset and every test run collided with a real relay on 8787.
const PORT = process.env.PORT ? Number(process.env.PORT) : 8787
const STORE_FILE = join(process.env.RC_DATA || join(ROOT, 'data'), 'store.json')
/** A push is bounded by the extension (chunks of ~150KB, commands of 20k
 *  chars); anything much bigger than a chunk of chunks is not a board update. */
const BODY_MAX = 1024 * 1024

/** The exact files this server will hand out. A whitelist, so no path in a
 *  URL can walk the filesystem. */
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/board.css': ['board.css', 'text/css; charset=utf-8'],
  '/board.js': ['board.js', 'text/javascript; charset=utf-8'],
}

/** The file-backed store. One JSON object for the whole relay — the index
 *  blob, the tails, the command queue — rewritten on every mutation. */
class FileStore {
  constructor(file) {
    this.file = file
    this.data = {}
  }

  async load() {
    let raw
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (e) {
      if (e.code === 'ENOENT') return // first run
      throw e
    }
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.data = parsed
        return
      }
    } catch {
      /* fall through — the file is not what we wrote */
    }
    // A store file this server cannot read is not thrown away: it is moved
    // aside and the relay starts empty, saying so — loudly, because silently
    // losing a board is the one failure a relay must not hide.
    const aside = `${this.file}.broken-${Date.now()}`
    await rename(this.file, aside)
    console.error(`[remote] store.json was unreadable — moved it to ${aside} and started empty`)
  }

  async #save() {
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, JSON.stringify(this.data))
    await rename(tmp, this.file)
  }

  async set(key, text) {
    this.data[key] = text
    await this.#save()
  }

  async get(key) {
    return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : null
  }

  async delete(key) {
    if (Object.prototype.hasOwnProperty.call(this.data, key)) {
      delete this.data[key]
      await this.#save()
    }
  }

  async list({ prefix }) {
    const blobs = Object.keys(this.data)
      .filter((k) => k.startsWith(prefix))
      .map((key) => ({ key }))
    return { blobs }
  }
}

/** Read a request body up to BODY_MAX; anything longer is refused rather than
 *  buffered. The rest is drained (not buffered) so the refusal can still be
 *  ANSWERED — destroying the socket here would leave the client hanging.
 *  Returns undefined when the body is not JSON. */
async function readBody(req) {
  const chunks = []
  let size = 0
  let tooBig = false
  for await (const chunk of req) {
    if (tooBig) continue // drain, do not buffer
    size += chunk.length
    if (size > BODY_MAX) {
      tooBig = true
      chunks.length = 0
      continue
    }
    chunks.push(chunk)
  }
  if (tooBig) throw new Error('request body too large')
  if (!chunks.length) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

const send = (res, status, text, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(text)
}

const store = new FileStore(STORE_FILE)
await store.load()

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  try {
    if (url.pathname === '/board' || url.pathname === '/board/') {
      const key = String(req.headers['x-rc-key'] ?? '')
      let body
      if (req.method === 'POST') {
        try {
          body = await readBody(req)
        } catch {
          send(res, 413, JSON.stringify({ ok: false, error: 'request body too large' }))
          return
        }
      }
      const out = await handle({
        method: req.method,
        boardId: key || url.searchParams.get('id') || '',
        key,
        tailKey: url.searchParams.get('tail') || undefined,
        cmds: url.searchParams.get('cmds') !== null,
        body,
      }, store)
      send(res, out.status, JSON.stringify(out.json))
      return
    }
    const file = STATIC[url.pathname]
    if (file) {
      const [name, type] = file
      try {
        const raw = await readFile(join(ROOT, 'public', name))
        send(res, 200, raw, type)
      } catch {
        send(res, 404, 'not found', 'text/plain')
      }
      return
    }
    send(res, 404, 'not found', 'text/plain')
  } catch (e) {
    console.error('[remote] request failed:', e)
    send(res, 500, JSON.stringify({ ok: false, error: 'the relay failed' }))
  }
})

server.listen(PORT, () => {
  // PORT=0 picks an ephemeral port (the tests use this); log the real one so a
  // caller can parse it.
  const port = typeof server.address() === 'object' && server.address() ? server.address().port : PORT
  console.log(`[remote] relay on http://localhost:${port} — board api /board, store ${STORE_FILE}`)
})
