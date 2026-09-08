/* The page IS the extension's board, so public/media/{board.js,board.css,theme.css}
 * must be byte-identical copies of the extension's media/ files — the sync is the
 * one thing that keeps them so, and a commit that edited them in place would be a
 * fork the extension does not know about.
 *
 * When the sibling checkout exists the three files are compared byte-for-byte and a
 * mismatch names the file. When it does not (a checkout without the extension next
 * to it), the check is skipped loudly — `UNCHECKED`, exit 0 — so the rest of the
 * suite still runs. That is the same pattern the extension's contract gate uses.
 */
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

// Resolve the sibling exactly the way scripts/sync-media.mjs does: from git's
// common dir (which in a worktree still names the MAIN checkout) one directory
// up, then `Agents-Kanban`.
const gitCommon = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  { cwd: ROOT, encoding: 'utf8' })
const MAIN = gitCommon.status === 0
  ? path.dirname(gitCommon.stdout.trim().replace(/\/+$/, ''))
  : ROOT
const sibling = path.join(path.dirname(MAIN), 'Agents-Kanban')

const FILES = ['board.js', 'board.css', 'theme.css']

if (!existsSync(path.join(sibling, 'media'))) {
  console.log(`\nUNCHECKED: no extension checkout at ${sibling} — public/media/ is not compared (skipped, exit 0)`)
  process.exit(0)
}

let fails = 0
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++ } else console.log('ok:', m) }

for (const name of FILES) {
  const from = path.join(sibling, 'media', name)
  const to = path.join(ROOT, 'public', 'media', name)
  if (!existsSync(from)) {
    console.error(`FAIL: ${name} — the extension has no media/${name}; run scripts/sync-media.mjs after it is restored`)
    fails++
    continue
  }
  const a = await fs.readFile(from)
  const b = await fs.readFile(to)
  ok(a.equals(b), `public/media/${name} is byte-identical to the extension's media/${name}`)
}

if (fails) {
  console.error(`\n${fails} media-sync failure(s) — run: node scripts/sync-media.mjs`)
  process.exit(1)
}
console.log('\nmedia-sync: the three public/media/ assets match the extension checkout')
