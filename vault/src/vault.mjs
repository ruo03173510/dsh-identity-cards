// 本地文件索引：注册、检索、对账、导出
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { openSync, readSync, closeSync, readdirSync, statSync, mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join, basename, extname, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

const HEAD_BYTES = 4096
// 工具链与临时目录：搜到也没用
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', '_tmp', '.collab', '.vscode', 'texlive'])
// 系统文件、Office 锁、安装包、模型权重
const SKIP_FILE_RE = /^(~\$|desktop\.ini$|thumbs\.db$)|\.(lnk|zip|rar|7z|cab|iso|onnx|sh)$/i

export function defaultHome() {
  return process.env.VAULT_HOME || join(homedir(), '.dsh', 'vault')
}

export function openVault(home = defaultHome()) {
  mkdirSync(home, { recursive: true })
  const db = new DatabaseSync(join(home, 'vault.db'))
  db.exec('pragma journal_mode = wal')
  // 索引是缓存，崩了从文件系统重建，不为耐久性付 fsync 成本
  db.exec('pragma synchronous = off')
  db.exec('pragma wal_autocheckpoint = 10000')
  db.exec('pragma foreign_keys = on')
  migrate(db)
  return { db, home }
}

function migrate(db) {
  db.exec(`
    create table if not exists meta(k text primary key, v text not null);
    create table if not exists roots(
      id integer primary key,
      name text unique not null,
      path text not null
    );
    create table if not exists files(
      id integer primary key,
      root_id integer not null references roots(id) on delete cascade,
      rel_path text not null,
      name text not null,
      ext text,
      size integer not null,
      mtime integer not null,
      birth integer,
      head_hash text,
      status text not null default 'ok',
      first_seen integer not null,
      last_seen integer not null,
      unique(root_id, rel_path)
    );
    create index if not exists files_name on files(name);
    create index if not exists files_status on files(status);
    create table if not exists grams(
      g text not null,
      file_id integer not null references files(id) on delete cascade,
      primary key(g, file_id)
    );
    create index if not exists grams_g on grams(g);
    create index if not exists grams_file on grams(file_id);
    create table if not exists tags(
      id integer primary key,
      name text unique not null,
      parent_id integer references tags(id)
    );
    create table if not exists file_tags(
      file_id integer not null references files(id) on delete cascade,
      tag_id integer not null references tags(id) on delete cascade,
      primary key(file_id, tag_id)
    );
  `)
  const cols = db.prepare('pragma table_info(files)').all().map((c) => c.name)
  if (!cols.includes('summary')) db.exec('alter table files add column summary text') // 旧记录留空，下次注册时补
  const row = db.prepare("select v from meta where k='schema_version'").get()
  if (!row) db.prepare("insert into meta(k, v) values('schema_version', '1')").run()
}

export function addRoot(v, name, path) {
  const abs = resolve(path)
  if (!existsSync(abs)) throw new Error(`路径不存在: ${abs}`)
  v.db.prepare('insert into roots(name, path) values(?, ?) on conflict(name) do update set path = excluded.path').run(name, abs)
  return { name, path: abs }
}

export function listRoots(v) {
  return v.db.prepare('select id, name, path from roots order by name').all()
}

export function loadExclude(home) {
  const f = join(home, 'exclude.json')
  if (!existsSync(f)) return { dirs: [], filePatterns: [] }
  try {
    // 手改的文件常带 BOM，JSON.parse 会直接抛
    return JSON.parse(readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return { dirs: [], filePatterns: [] }
  }
}

function makeWalkOpts(v, opts) {
  const ex = opts.exclude ?? loadExclude(v.home)
  const extra = (ex.filePatterns ?? []).filter(Boolean)
  return {
    all: Boolean(opts.all),
    skipDirs: new Set([...SKIP_DIRS, ...(ex.dirs ?? [])]),
    skipFiles: extra.length ? new RegExp(`(?:${SKIP_FILE_RE.source})|(?:${extra.join('|')})`, 'i') : SKIP_FILE_RE
  }
}

function bump(map, key) {
  map[key] = (map[key] ?? 0) + 1
}

function rootFor(roots, abs) {
  const low = abs.toLowerCase()
  let best = null
  for (const r of roots) {
    const rp = resolve(r.path).toLowerCase()
    if (low === rp || low.startsWith(rp + sep)) {
      if (!best || rp.length > best.rp.length) best = { ...r, rp }
    }
  }
  return best
}

function collect(abs, opts, out, stats) {
  const st = statSync(abs, { throwIfNoEntry: false })
  if (!st) return
  if (st.isFile()) {
    if (!opts.all && opts.skipFiles.test(basename(abs))) {
      bump(stats.files, extname(abs) || basename(abs))
      return
    }
    out.push(abs)
    return
  }
  if (!st.isDirectory()) return
  let ents
  try { ents = readdirSync(abs, { withFileTypes: true }) } catch { return }
  for (const ent of ents) {
    if (ent.isSymbolicLink()) continue
    const p = join(abs, ent.name)
    if (ent.isDirectory()) {
      if (!opts.all && opts.skipDirs.has(ent.name)) {
        bump(stats.dirs, ent.name)
        continue
      }
      collect(p, opts, out, stats)
    } else if (ent.isFile()) {
      if (!opts.all && opts.skipFiles.test(ent.name)) {
        bump(stats.files, extname(ent.name) || ent.name)
        continue
      }
      out.push(p)
    }
  }
}

function readBytes(abs, bytes = HEAD_BYTES) {
  const fd = openSync(abs, 'r')
  try {
    const buf = Buffer.allocUnsafe(bytes)
    const n = readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, n)
  } finally {
    closeSync(fd)
  }
}

function headHash(buf) {
  return createHash('sha1').update(buf).digest('hex').slice(0, 16)
}

function summarize(abs) {
  return readBytes(abs).toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 120)
}

// docx/pptx/xlsx 都是 zip，只取正文那个 entry，不落临时文件
const ZIP_EXT = new Set(['docx', 'pptx', 'xlsx'])
const ZIP_ENTRY = { docx: 'word/document.xml', pptx: 'ppt/slides/slide1.xml', xlsx: 'xl/sharedStrings.xml' }

function readZipEntry(abs, entryName) {
  const size = Math.min(statSync(abs).size, 64 * 1024 * 1024)
  const buf = Buffer.allocUnsafe(size)
  const fd = openSync(abs, 'r')
  try {
    readSync(fd, buf, 0, size, 0)
  } finally {
    closeSync(fd)
  }
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd < 0) return null
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  let p = cdOffset
  const end = cdOffset + cdSize
  while (p + 46 <= end && buf.readUInt32LE(p) === 0x02014b50) {
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    if (name === entryName) {
      const lnLen = buf.readUInt16LE(localOffset + 26)
      const leLen = buf.readUInt16LE(localOffset + 28)
      const start = localOffset + 30 + lnLen + leLen
      const data = buf.subarray(start, start + compSize)
      try {
        return method === 8 ? inflateRawSync(data) : data
      } catch {
        return null
      }
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  return null
}

function summaryFor(abs, ext, raw) {
  if (TEXT_EXT.has(ext)) return raw.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 120)
  // 空串表示「算过但抽不出内容」，跟「还没算过」的 null 区分开，避免每次注册重算
  if (ZIP_EXT.has(ext)) return zipSummary(abs, ext) ?? ''
  return null
}

function zipSummary(abs, ext) {
  const entry = ZIP_ENTRY[ext]
  if (!entry) return null
  const xml = readZipEntry(abs, entry)
  if (!xml) return null
  return xml.toString('utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || null
}

// 文本类才抽首段当摘要，docx/pdf 要解析正文，留给后续
const TEXT_EXT = new Set(['md', 'txt', 'py', 'c', 'cpp', 'h', 'js', 'mjs', 'json', 'yaml', 'yml', 'toml', 'csv', 'log', 'tex', 'html', 'css', 'xml', 'drawio', 'ini', 'cfg'])

const CN_NUM = { '零': '0', '一': '1', '二': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9' }

export function bigrams(text) {
  const s = String(text).toLowerCase()
  const out = new Set()
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i]
    const b = s[i + 1]
    if (/\s/.test(a) || /\s/.test(b)) continue
    out.add(a + b)
    const ca = CN_NUM[a] ?? a
    const cb = CN_NUM[b] ?? b
    // 中文数字同时存阿拉伯变体，让「实验三」和「实验3」互查
    if (ca !== a || cb !== b) out.add(ca + cb)
  }
  return out
}

export function register(v, targets, opts = {}) {
  const db = v.db
  const roots = listRoots(v)
  if (!roots.length) throw new Error('还没有登记资料根，先 vault root add <名字> <路径>')
  const now = Date.now()
  const result = { scanned: 0, added: 0, updated: 0, skipped: 0, outside: 0, errors: [], skipped_dirs: {}, skipped_files: {} }
  const walkOpts = makeWalkOpts(v, opts)
  const paths = []
  for (const t of targets) {
    let abs = resolve(t)
    if (!existsSync(abs)) {
      // 传「计算机图形学/实验4」这种相对目录名时，按已注册目录解析
      const kw = String(t).replace(/\\/g, '/').toLowerCase()
      const hit = dirs(v, kw).filter((h) => h.rel.toLowerCase().endsWith(kw))
      if (hit.length === 1) {
        abs = hit[0].abs
      } else {
        result.errors.push(hit.length ? `「${t}」匹配 ${hit.length} 个目录：` + hit.map((h) => h.rel).join(' | ') : `不存在: ${abs}`)
        continue
      }
    }
    collect(abs, walkOpts, paths, { dirs: result.skipped_dirs, files: result.skipped_files })
  }
  result.scanned = paths.length

  const qOld = db.prepare('select id, size, mtime, summary from files where root_id = ? and rel_path = ?')
  const qTouch = db.prepare('update files set last_seen = ? where id = ?')
  const qSum = db.prepare('update files set summary = ? where id = ?')
  const qIns = db.prepare(`insert into files(root_id, rel_path, name, ext, size, mtime, birth, head_hash, summary, status, first_seen, last_seen)
    values(?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?)`)
  const qUpd = db.prepare(`update files set name = ?, ext = ?, size = ?, mtime = ?, birth = ?, head_hash = ?, summary = ?, status = 'ok', last_seen = ? where id = ?`)
  const qDelG = db.prepare('delete from grams where file_id = ?')
  const qInsG = db.prepare('insert or ignore into grams(g, file_id) values(?, ?)')

  let pending = 0
  db.exec('begin')
  for (const p of paths) {
    const r = rootFor(roots, p)
    if (!r) {
      result.outside++
      continue
    }
    let st
    try {
      st = statSync(p)
    } catch {
      result.errors.push(`读不到: ${p}`)
      continue
    }
    const rel = relative(resolve(r.path), p).split(sep).join('/')
    const name = basename(p)
    const ext = extname(p).slice(1).toLowerCase()
    const size = st.size
    const mtime = Math.round(st.mtimeMs)
    const old = qOld.get(r.id, rel)
    if (old && old.size === size && old.mtime === mtime) {
      // 旧库没摘要的补算一次，不改 mtime 也不重扫
      if (old.summary === null && (TEXT_EXT.has(ext) || ZIP_EXT.has(ext))) {
        qSum.run(summaryFor(p, ext, readBytes(p)), old.id)
        result.updated++
      } else {
        qTouch.run(now, old.id)
        result.skipped++
      }
      continue
    }
    const raw = readBytes(p)
    const hash = headHash(raw)
    const summary = summaryFor(p, ext, raw)
    const birth = Math.round(st.birthtimeMs)
    let id
    if (old) {
      qUpd.run(name, ext, size, mtime, birth, hash, summary, now, old.id)
      id = old.id
      result.updated++
    } else {
      const res = qIns.run(r.id, rel, name, ext, size, mtime, birth, hash, summary, now, now)
      id = Number(res.lastInsertRowid)
      result.added++
    }
    if (old) qDelG.run(id) // 新文件没有旧 grams，省一次索引查找
    for (const g of bigrams(name + ' ' + rel)) qInsG.run(g, id)
    if (++pending >= 500) {
      db.exec('commit')
      db.exec('begin')
      pending = 0
    }
  }
  db.exec('commit')
  return result
}

function termRows(db, term) {
  const gs = [...bigrams(term)]
  if (!gs.length) {
    return db.prepare("select id from files where status = 'ok' and (name like ? or rel_path like ?)").all(`%${term}%`, `%${term}%`).map((r) => ({ id: r.id, s: 1 }))
  }
  if (gs.length === 1) {
    return db.prepare('select file_id from grams where g = ?').all(gs[0]).map((r) => ({ id: r.file_id, s: 1 }))
  }
  // 先精确求交：50k 档实测 p95 37ms
  const sql = 'select file_id from grams where g = ?' + ' intersect select file_id from grams where g = ?'.repeat(gs.length - 1)
  const exact = db.prepare(sql).all(...gs).map((r) => ({ id: r.file_id, s: gs.length }))
  if (exact.length >= 3) return exact
  // 精确结果太少，说明是口语化查询（实验五 vs 实验5、图形学 vs 计算机图形学），
  // 退回覆盖率排序：命中 40% 的 bigram 就进候选，命中数就是分数
  const ph = gs.map(() => '?').join(',')
  const need = Math.max(1, Math.ceil(gs.length * 0.4))
  const fuzzy = db.prepare(`select file_id, count(*) c from grams where g in (${ph}) group by file_id having c >= ? order by c desc limit 50`).all(...gs, need)
  const seen = new Set(exact.map((r) => r.id))
  return exact.concat(fuzzy.filter((r) => !seen.has(r.file_id)).map((r) => ({ id: r.file_id, s: r.c })))
}

export function find(v, query, opts = {}) {
  const db = v.db
  const limit = Math.max(1, Number(opts.limit ?? 8))
  const terms = String(query).trim().split(/[\s,，、;；:：]+/).filter(Boolean)
  if (!terms.length) return []
  const hit = new Map()
  for (const term of terms) {
    for (const r of termRows(db, term)) {
      const prev = hit.get(r.id) ?? { n: 0, s: 0 }
      hit.set(r.id, { n: prev.n + 1, s: prev.s + (r.s ?? 0) })
    }
  }
  if (!hit.size) return []
  const cand = [...hit.entries()].sort((a, b) => b[1].s - a[1].s || b[1].n - a[1].n).slice(0, limit * 6)
  const ph = cand.map(() => '?').join(',')
  const rows = db.prepare(`select f.id, f.rel_path, f.name, f.ext, f.size, f.mtime, f.summary, r.name root
    from files f join roots r on r.id = f.root_id
    where f.id in (${ph}) and f.status = 'ok'`).all(...cand.map((x) => x[0]))
  const byId = new Map(rows.map((r) => [r.id, r]))
  const scored = []
  for (const [id, t] of cand) {
    const row = byId.get(id)
    if (!row) continue
    let score = t.n * 10 + t.s
    const lows = terms.map((x) => x.toLowerCase())
    const nameLow = row.name.toLowerCase()
    const pathLow = row.rel_path.toLowerCase()
    for (const low of lows) {
      if (nameLow.includes(low)) score += 6
      if (pathLow.includes(low)) score += 3
    }
    scored.push({ ...row, score })
  }
  scored.sort((a, b) => b.score - a.score || b.mtime - a.mtime)
  return scored.slice(0, limit)
}

function readHead(abs, bytes) {
  const fd = openSync(abs, 'r')
  try {
    const buf = Buffer.allocUnsafe(bytes)
    const n = readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

export function show(v, id, opts = {}) {
  const db = v.db
  const row = db.prepare('select f.*, r.name root, r.path root_path from files f join roots r on r.id = f.root_id where f.id = ?').get(Number(id))
  if (!row) throw new Error(`没有这个文件 id: ${id}`)
  const abs = join(row.root_path, ...row.rel_path.split('/'))
  const out = { ...row, abs, exists: existsSync(abs) }
  if (opts.text && out.exists) out.text = readHead(abs, HEAD_BYTES)
  return out
}

export function verify(v, opts = {}) {
  const db = v.db
  const roots = listRoots(v).filter((r) => !opts.root || r.name === opts.root)
  const report = { ok: 0, missing: [], moved: [], new: [] }
  for (const r of roots) {
    const base = resolve(r.path)
    const disk = []
    collect(base, makeWalkOpts(v, opts), disk, { dirs: {}, files: {} })
    const diskSet = new Set(disk.map((p) => relative(base, p).split(sep).join('/')))
    const rows = db.prepare("select id, rel_path, size, birth from files where root_id = ? and status = 'ok'").all(r.id)
    const dbSet = new Set(rows.map((x) => x.rel_path))

    const print = new Map()
    for (const p of diskSet) {
      const st = statSync(join(base, ...p.split('/')), { throwIfNoEntry: false })
      if (!st) continue
      const key = `${st.size}:${Math.round(st.birthtimeMs)}`
      if (!print.has(key)) print.set(key, [])
      print.get(key).push(p)
    }

    for (const row of rows) {
      if (diskSet.has(row.rel_path)) {
        report.ok++
        continue
      }
      const key = `${row.size}:${row.birth}`
      const cand = (print.get(key) ?? []).find((p) => !dbSet.has(p))
      if (cand) {
        db.prepare('update files set rel_path = ? where id = ?').run(cand, row.id)
        diskSet.delete(cand)
        dbSet.delete(row.rel_path)
        dbSet.add(cand)
        report.moved.push({ id: row.id, from: row.rel_path, to: cand })
      } else {
        db.prepare("update files set status = 'missing' where id = ?").run(row.id)
        dbSet.delete(row.rel_path)
        report.missing.push({ id: row.id, rel_path: row.rel_path })
      }
    }
    for (const p of diskSet) {
      if (!dbSet.has(p)) report.new.push({ root: r.name, rel_path: p })
    }
  }
  return report
}

export function exportManifest(v) {
  const db = v.db
  const rows = db.prepare(`select r.name root, f.rel_path, f.name, f.size, f.mtime, f.birth, f.head_hash
    from files f join roots r on r.id = f.root_id
    where f.status = 'ok' order by r.name, f.rel_path`).all()
  const lines = rows.map((r) => JSON.stringify({ root: r.root, rel: r.rel_path, size: r.size, mtime: r.mtime, birth: r.birth, hash: r.head_hash }))
  const file = join(v.home, 'manifest.jsonl')
  writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8')
  return { file, count: lines.length }
}

export function importManifest(v, file) {
  const db = v.db
  const roots = new Map(listRoots(v).map((r) => [r.name, r]))
  const now = Date.now()
  const stats = { added: 0, updated: 0, missing: 0 }
  const qGet = db.prepare('select id from files where root_id = ? and rel_path = ?')
  const qIns = db.prepare(`insert into files(root_id, rel_path, name, ext, size, mtime, birth, head_hash, summary, status, first_seen, last_seen)
    values(?, ?, ?, ?, ?, ?, ?, ?, null, 'ok', ?, ?)`)
  const qUpd = db.prepare('update files set size = ?, mtime = ?, birth = ?, head_hash = ?, status = ?, last_seen = ? where id = ?')
  const qDelG = db.prepare('delete from grams where file_id = ?')
  const qInsG = db.prepare('insert or ignore into grams(g, file_id) values(?, ?)')
  const text = readFileSync(file, 'utf8')
  db.exec('begin')
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const e = JSON.parse(line)
    const r = roots.get(e.root)
    if (!r) {
      stats.missing++
      continue
    }
    const name = e.rel.split('/').pop()
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : ''
    const old = qGet.get(r.id, e.rel)
    let id
    if (old) {
      qUpd.run(e.size, e.mtime, e.birth ?? null, e.hash, 'ok', now, old.id)
      id = old.id
      stats.updated++
    } else {
      const res = qIns.run(r.id, e.rel, name, ext, e.size, e.mtime, e.birth ?? null, e.hash, now, now)
      id = Number(res.lastInsertRowid)
      stats.added++
    }
    if (old) qDelG.run(id)
    for (const g of bigrams(name + ' ' + e.rel)) qInsG.run(g, id)
  }
  db.exec('commit')
  return stats
}

// 按目录名找绝对路径：发「实验4」就能定位，不用每次拼全路径
export function dirs(v, keyword) {
  const db = v.db
  const kw = String(keyword ?? '').toLowerCase()
  const roots = new Map(listRoots(v).map((r) => [r.id, r]))
  const rows = db.prepare("select root_id, rel_path from files where status = 'ok'").all()
  const out = new Map()
  for (const r of rows) {
    const parts = r.rel_path.split('/')
    parts.pop()
    if (!parts.length) continue
    const rel = parts.join('/')
    if (kw && !rel.toLowerCase().includes(kw)) continue
    const root = roots.get(r.root_id)
    if (!root) continue
    const abs = join(root.path, ...parts)
    out.set(abs, { root: root.name, rel, abs })
  }
  return [...out.values()].sort((a, b) => a.rel.localeCompare(b.rel))
}

// 扫所有已登记根，增量补齐，不用记上次扫了哪
export function refresh(v, opts = {}) {
  const roots = listRoots(v).filter((r) => !opts.root || r.name === opts.root)
  return register(v, roots.map((r) => r.path), opts)
}

export function stats(v) {
  const db = v.db
  const total = db.prepare("select count(*) c from files where status = 'ok'").get().c
  const missing = db.prepare("select count(*) c from files where status = 'missing'").get().c
  const byExt = db.prepare("select coalesce(ext, '') ext, count(*) c from files where status = 'ok' group by ext order by c desc limit 20").all()
  const byRoot = db.prepare(`select r.name, count(f.id) c from roots r left join files f on f.root_id = r.id and f.status = 'ok' group by r.id order by c desc`).all()
  return { total, missing, byExt, byRoot }
}
