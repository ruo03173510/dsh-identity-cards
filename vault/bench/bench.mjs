// 基准：注册吞吐、检索延迟、召回、体积
import { openVault, addRoot, register, find, exportManifest } from '../src/vault.mjs'
import { ensureData, queries } from './gen.mjs'
import { join, dirname } from 'node:path'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'

const BASE = join(import.meta.dirname, '..', '_tmp', 'bench')
const SIZES = [1000, 5000, 10000, 50000]
const QUERY_N = 200

function pct(sorted, p) {
  const i = Math.min(sorted.length - 1, Math.floor(sorted.length * p))
  return sorted[i]
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

const rows = []
mkdirSync(BASE, { recursive: true })

for (const n of SIZES) {
  const data = join(BASE, 'data-' + n)
  const home = join(BASE, 'home-' + n)
  mkdirSync(data, { recursive: true })
  rmSync(home, { recursive: true, force: true })

  const tGen = performance.now()
  const files = ensureData(data, n)
  const genMs = performance.now() - tGen

  const v = openVault(home)
  addRoot(v, 'data', data)

  const tReg = performance.now()
  const reg = register(v, [data])
  const regMs = performance.now() - tReg

  const qs = queries(files, QUERY_N)
  const times = []
  let hit = 0
  for (const { q, expect } of qs) {
    const t = performance.now()
    const res = find(v, q, { limit: 5 })
    times.push(performance.now() - t)
    if (res.some((r) => r.rel_path === expect)) hit++
  }
  times.sort((a, b) => a - b)

  const dbBytes = statSync(join(home, 'vault.db')).size
  const rssMb = process.memoryUsage().rss / 1048576

  rows.push({
    n,
    gen_ms: Math.round(genMs),
    register_ms: Math.round(regMs),
    register_added: reg.added,
    register_skipped: reg.skipped,
    find_p50_ms: Number(pct(times, 0.5).toFixed(2)),
    find_p95_ms: Number(pct(times, 0.95).toFixed(2)),
    find_max_ms: Number(times[times.length - 1].toFixed(2)),
    recall5: Number((hit / qs.length).toFixed(4)),
    db_mb: Number((dbBytes / 1048576).toFixed(1)),
    rss_mb: Number(rssMb.toFixed(1))
  })
  console.log(JSON.stringify(rows[rows.length - 1]))

  if (n === 50000) {
    const coldTimes = []
    const cli = join(import.meta.dirname, '..', 'src', 'cli.mjs')
    for (let i = 0; i < 3; i++) {
      const t = performance.now()
      const r = spawnSync(process.execPath, [cli, 'find', qs[i].q, '--limit', '1'], {
        env: { ...process.env, VAULT_HOME: home },
        stdio: 'ignore',
        timeout: 30000
      })
      if (r.status === 0) coldTimes.push(performance.now() - t)
    }
    rows[rows.length - 1].cold_start_ms = coldTimes.length ? Math.round(median(coldTimes)) : null
    const exp = exportManifest(v)
    rows[rows.length - 1].manifest_kb = Number((statSync(exp.file).size / 1024).toFixed(1))
  }
  v.db.close()
}

writeFileSync(join(BASE, 'result.json'), JSON.stringify(rows, null, 2))
console.log('\n结果已写入 ' + join(BASE, 'result.json'))
