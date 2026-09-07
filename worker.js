/* The relay as a Cloudflare Worker. The KV namespace is the store; the static
 * page (public/) is served by Workers Static Assets. wrangler.toml sets
 * `run_worker_first = false`, so assets answer first and this worker is
 * invoked only for requests they cannot serve — which is /board, the one path
 * this file handles.
 *
 * All behaviour lives in functions/board-core.mjs; this file is a store
 * adapter and a transport, nothing more. Same rules as the other hosts: no
 * stored secret, the board address is the id derived from the pairing code,
 * and commands are only QUEUED here — whether they run is the extension's
 * decision.
 */
import { handle } from './functions/board-core.mjs'

/** KV in board-core's store shape: `set/get/delete` by string key, `list` as
 *  `{ blobs: [{ key }] }`. KV's own list returns `keys` with a `name` field,
 *  which is the one mapping this adapter exists for. Exported so the repo's
 *  test suite can pin the mapping without a Cloudflare account. */
export const kvStore = (env) => ({
  async set(key, text) {
    await env.BOARDS.put(key, text)
  },
  async get(key) {
    return await env.BOARDS.get(key)
  },
  async delete(key) {
    await env.BOARDS.delete(key)
  },
  async list({ prefix }) {
    const res = await env.BOARDS.list({ prefix })
    return { blobs: res.keys.map((k) => ({ key: k.name })) }
  },
})

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname !== '/board') {
      // With `run_worker_first = false` this branch should be unreachable —
      // assets serve everything else. It is a guard for an environment where
      // assets are not configured, not a router.
      return new Response('not found', { status: 404 })
    }
    const key = request.headers.get('x-rc-key') ?? ''
    let body
    if (request.method === 'POST') {
      try {
        body = await request.json()
      } catch {
        body = undefined
      }
    }
    const out = await handle({
      method: request.method,
      boardId: key || url.searchParams.get('id') || '',
      key,
      tailKey: url.searchParams.get('tail') || undefined,
      cmds: url.searchParams.get('cmds') !== null,
      body,
    }, kvStore(env))
    return new Response(JSON.stringify(out.json), {
      status: out.status,
      headers: { 'content-type': 'application/json' },
    })
  },
}
