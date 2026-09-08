/* Copy the extension's own webview assets into public/media/, verbatim.
 *
 * The remote page IS the extension's board — media/board.js, media/board.css
 * and media/theme.css are carried byte-for-byte, not re-implemented here. The
 * one way to keep them identical is to copy them, which this script does.
 *
 * The sibling is found the same way the extension's scripts/check-contract.mjs
 * finds the relay: from git's common dir (which in a worktree still names the
 * MAIN checkout) one directory up, then `Agents-Kanban`. An explicit path
 * argument overrides that for a checkout that is not a sibling.
 *
 *   node scripts/sync-media.mjs            # copy from ../Agents-Kanban
 *   node scripts/sync-media.mjs /path/to/Agents-Kanban
 *
 * Re-run this after the extension's media/ changes (see README).
 */
import { copyFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

// MAIN is the main checkout root, resolvable even from inside a worktree.
const gitCommon = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  { cwd: HERE, encoding: 'utf8' })
const MAIN = gitCommon.status === 0
  ? path.dirname(gitCommon.stdout.trim().replace(/\/+$/, ''))
  : ROOT

const sibling = path.join(path.dirname(MAIN), 'Agents-Kanban')
const src = process.argv[2] ? path.resolve(process.argv[2]) : sibling

const FILES = ['board.js', 'board.css', 'theme.css']

if (!existsSync(path.join(src, 'media'))) {
  console.error(`sync-media: no extension checkout at ${src} (media/ is missing).`)
  console.error('  Pass an explicit path: node scripts/sync-media.mjs /path/to/Agents-Kanban')
  process.exit(1)
}

const outDir = path.join(ROOT, 'public', 'media')
await mkdir(outDir, { recursive: true })

for (const name of FILES) {
  const from = path.join(src, 'media', name)
  if (!existsSync(from)) {
    console.error(`sync-media: ${from} is missing — is the extension checkout complete?`)
    process.exit(1)
  }
  await copyFile(from, path.join(outDir, name))
  console.log(`ok: public/media/${name} <- ${from}`)
}

console.log('sync-media: the three assets are now byte-identical copies of the extension’s.')
