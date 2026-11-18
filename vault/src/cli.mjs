#!/usr/bin/env node
// 命令行入口：vault <动作> [参数]
import { openVault, addRoot, listRoots, register, find, show, verify, exportManifest, importManifest, dirs, refresh, stats } from './vault.mjs'

const argv = process.argv.slice(2)
const cmd = argv[0]
const args = []
const opts = {}

for (let i = 1; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--') continue
  if (a.startsWith('--')) {
    const body = a.slice(2)
    const eq = body.indexOf('=')
    if (eq >= 0) {
      opts[body.slice(0, eq)] = body.slice(eq + 1)
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      opts[body] = argv[++i]
    } else {
      opts[body] = true
    }
  } else {
    args.push(a)
  }
}

function print(obj) {
  if (opts.json) {
    console.log(JSON.stringify(obj, null, 2))
    return
  }
  if (cmd === 'find') return printFind(obj)
  if (cmd === 'show') return printShow(obj)
  if (cmd === 'verify') return printVerify(obj)
  console.log(format(obj))
}

// 对账结果按条数汇总，避免几千条 missing 直接灌进上下文
function printVerify(r) {
  console.log(`ok: ${r.ok}  missing: ${r.missing.length}  moved: ${r.moved.length}  new: ${r.new.length}`)
  const show = (label, list, pick) => {
    if (!list.length) return
    console.log(`${label}:`)
    for (const x of list.slice(0, 10)) console.log(`  ${pick(x)}`)
    if (list.length > 10) console.log(`  ... 还有 ${list.length - 10} 条`)
  }
  show('missing', r.missing, (x) => x.rel_path)
  show('moved', r.moved, (x) => `${x.from} -> ${x.to}`)
  show('new', r.new, (x) => `${x.root}/${x.rel_path}`)
}

// 默认输出只留 id、相对路径、大小；name/ext/mtime/root/score 都是可推导或重复的
function printFind(rows) {
  if (!rows.length) {
    console.log('(空)')
    return
  }
  if (opts.meta) {
    // 歧义时才用：多一列日期和一行摘要，每条多约 40 token
    for (const r of rows) {
      console.log(`${r.id}\t${r.rel_path}\t${(r.size / 1024).toFixed(0)}KB\t${new Date(r.mtime).toISOString().slice(0, 10)}`)
      if (r.summary) console.log(`\t${r.summary}`)
    }
    return
  }
  for (const r of rows) console.log(`${r.id}\t${r.rel_path}\t${r.size}`)
}

function printShow(s) {
  const lines = [`id: ${s.id}`, `路径: ${s.abs}`, `大小: ${s.size}`, `修改: ${new Date(s.mtime).toISOString().slice(0, 10)}`]
  if (!s.exists) lines.push('状态: 文件不在了')
  if (s.text) lines.push('', s.text)
  console.log(lines.join('\n'))
}

function format(obj) {
  if (Array.isArray(obj)) {
    if (!obj.length) return '(空)'
    const keys = Object.keys(obj[0])
    const lines = [keys.join('\t')]
    for (const row of obj) lines.push(keys.map((k) => row[k]).join('\t'))
    return lines.join('\n')
  }
  if (obj && typeof obj === 'object') {
    return Object.entries(obj).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n')
  }
  return String(obj)
}

function fail(e) {
  console.error(e.message)
  process.exit(1)
}

try {
  const v = openVault()
  switch (cmd) {
    case 'root': {
      const sub = args[0]
      if (sub === 'add') {
        const name = args[1]
        const path = args[2]
        if (!name || !path) throw new Error('用法: vault root add <名字> <路径>')
        print(addRoot(v, name, path))
      } else if (sub === 'list' || !sub) {
        print(listRoots(v))
      } else {
        throw new Error('用法: vault root add|list')
      }
      break
    }
    case 'register': {
      if (!args.length) throw new Error('用法: vault register <路径...> [--all]')
      const r = register(v, args, { all: Boolean(opts.all) })
      print(r)
      break
    }
    case 'find': {
      const q = args.join(' ')
      if (!q) throw new Error('用法: vault find <查询> [--limit 8]')
      const rows = find(v, q, { limit: Number(opts.limit ?? 8) })
      print(rows)
      break
    }
    case 'show': {
      const id = args[0]
      if (!id) throw new Error('用法: vault show <id> [--text]')
      print(show(v, id, { text: Boolean(opts.text) }))
      break
    }
    case 'verify': {
      print(verify(v, { root: opts.root }))
      break
    }
    case 'export': {
      print(exportManifest(v))
      break
    }
    case 'import': {
      if (!args[0]) throw new Error('用法: vault import <manifest.jsonl>')
      print(importManifest(v, args[0]))
      break
    }
    case 'dirs': {
      print(dirs(v, args.join(' ')))
      break
    }
    case 'refresh': {
      print(refresh(v, { root: opts.root }))
      break
    }
    case 'stats': {
      print(stats(v))
      break
    }
    default:
      throw new Error('用法: vault root|register|find|show|verify|export|import|stats')
  }
  v.db.close()
} catch (e) {
  fail(e)
}
