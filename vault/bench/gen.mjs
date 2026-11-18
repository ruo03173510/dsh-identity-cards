// 合成数据集：固定种子，可复用
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname, basename, relative, sep } from 'node:path'

const COURSES = ['多媒体技术', '计算机图形学', '软件工程', '操作系统', '计算机网络', '数据库',
  '模式识别与机器学习', '计算机视觉', '最优化方法', '汇编语言', '物联网导论', '物联网智能控制',
  '习思想', '职业规划大赛']
const KINDS = ['实验', '课堂录音', '课程设计', '知识点', '课件', '作业', '复习', '总结']
const EXTS = ['pdf', 'docx', 'md', 'pptx', 'png', 'drawio', 'xlsx', 'txt']

export function generate(root, n, seed = 42) {
  let s = seed >>> 0
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
  const dirs = new Set()
  const made = []
  for (let i = 0; i < n; i++) {
    const c = COURSES[(rnd() * COURSES.length) | 0]
    const k = KINDS[(rnd() * KINDS.length) | 0]
    const w = 1 + ((rnd() * 16) | 0)
    const num = 1 + ((rnd() * 9) | 0)
    const e = EXTS[(rnd() * EXTS.length) | 0]
    const dir = join(root, c, `${k}${w}`, `第${num}次`)
    if (!dirs.has(dir)) {
      mkdirSync(dir, { recursive: true })
      dirs.add(dir)
    }
    const name = `${c}-${k}${w}-${String(i).padStart(6, '0')}.${e}`
    const file = join(dir, name)
    writeFileSync(file, Buffer.alloc(256 + ((rnd() * 2048) | 0)))
    made.push(relative(root, file).split(sep).join('/'))
  }
  return made
}

export function queries(files, n = 200, seed = 7) {
  let s = seed >>> 0
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
  const out = []
  const used = new Set()
  while (out.length < n && used.size < files.length) {
    const i = (rnd() * files.length) | 0
    if (used.has(i)) continue
    used.add(i)
    const rel = files[i]
    const name = rel.split('/').pop()
    const q = name.replace(/\.[^.]+$/, '')
    out.push({ q, expect: rel })
  }
  return out
}

export function ensureData(root, n) {
  const listFile = join(dirname(root), basename(root) + '.files.json')
  if (existsSync(listFile)) return JSON.parse(readFileSync(listFile, 'utf8'))
  const made = generate(root, n)
  writeFileSync(listFile, JSON.stringify(made))
  return made
}
