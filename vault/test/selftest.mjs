// 自检：注册、检索、对账、导出导入
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openVault, addRoot, listRoots, register, find, show, verify, exportManifest, importManifest, stats } from '../src/vault.mjs'

let pass = 0
let fail = 0

function t(name, fn) {
  try {
    fn()
    pass++
    console.log('PASS ' + name)
  } catch (e) {
    fail++
    console.log('FAIL ' + name + ' :: ' + e.message)
  }
}

function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`)
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg)
}

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'vault-'))
  const data = join(base, 'data')
  const put = (rel, body = 'x') => {
    const abs = join(data, ...rel.split('/'))
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body)
    return abs
  }
  put('多媒体技术/实验5/语音交互智能家居.docx', 'a'.repeat(100))
  put('多媒体技术/实验4/数字图像处理.md', 'b'.repeat(200))
  put('计算机图形学/实验3/三角形光栅化.md', 'c'.repeat(300))
  put('软件工程/详细设计/需求规格说明书.docx', 'd'.repeat(400))
  put('notes/graphics-pipeline.md', 'e'.repeat(500))
  put('README.md', 'f'.repeat(10))
  return { base, data, put }
}

t('addRoot 后 listRoots 能读到', () => {
  const { base, data } = setup()
  const v = openVault(join(base, 'home'))
  addRoot(v, 'data', data)
  const roots = listRoots(v)
  eq(roots.length, 1, '根数量')
  eq(roots[0].name, 'data', '根名')
  v.db.close()
  rmSync(base, { recursive: true, force: true })
})

t('首次注册 6 个文件', () => {
  const { base, data } = setup()
  const v = openVault(join(base, 'home'))
  addRoot(v, 'data', data)
  const r = register(v, [data])
  eq(r.scanned, 6, '扫描数')
  eq(r.added, 6, '新增数')
  eq(r.outside, 0, '根外数')
  v.db.close()
  rmSync(base, { recursive: true, force: true })
})

t('重复注册全部跳过', () => {
  const { base, data } = setup()
  const v = openVault(join(base, 'home'))
  addRoot(v, 'data', data)
  register(v, [data])
  const r = register(v, [data])
  eq(r.skipped, 6, '跳过数')
  eq(r.added, 0, '新增数')
  v.db.close()
  rmSync(base, { recursive: true, force: true })
})

t('改内容后只更新那一个', () => {
  const { base, data, put } = setup()
  const v = openVault(join(base, 'home'))
  addRoot(v, 'data', data)
  register(v, [data])
  put('README.md', 'z'.repeat(64))
  const r = register(v, [data])
  eq(r.updated, 1, '更新数')
  eq(r.added, 0, '新增数')
  v.db.close()
  rmSync(base, { recursive: true, force: true })
})

t('两字中文能查到', () => {
  const { base, data } = setup()
  const v = openVault(join(base, 'home'))
  addRoot(v, 'data', data)
  register(v, [data])
  const rows = find(v, '实验')
  ok(rows.length >= 3, '实验 至少 3 条，实际 ' + rows.length)
  v.db.close()
  rmSync(base, { recursive: true, force: true })
})

t('长中文短语能精确命中', () => {
  const { base, data } = setup()
  const v = openVault(join(base, 'home'))
  addRoot(v, 'data', data)
  register(v, [data])
  const rows = find(v, '语音交互智能家居')
  ok(rows.length >= 1, '应命中')
  ok(rows[0].rel_path.includes('语音交互'), 'Top1 路径：' + rows[0].rel_path)
  v.db.close()
  rmSync(base, { recursive: true, force: true })
})

t('英文文件名能命中', () => {
  const { base, data } = setup()
  const v = openVault(join(base, 'home'))
  addRoot(v, 'data', data)
  register(v, [data])
  const rows = find(v, 'pipeline')
  ok(rows.length >= 1, '应命中 graphics-pipeline')
  v.db.close()
  rmSync(base, { recursive: true, force: true })
})

t('查不到时返回空数组', () => {
  const { base, data } = setup()
  const v = openVault(join(base, 'home'))
  addRoot(v, 'data', data)
  register(v, [data])
  eq(find(v, '量子计算催化').length, 0, '结果数')
  v.db.close()
  rmSync(base, { recursive: true, force: true })
})

t('show 能定位绝对路径', () => {
  const { base, data } = setup()
  const v = openVault(join(base, 'home'))
  addRoot(v, 'data', data)
  register(v, [data])
  const rows = find(v, '语音交互')
  const s = show(v, rows[0].id)
  ok(s.exists, '文件应存在')
  ok(s.abs.includes('语音交互智能家居.docx'), '路径：' + s.abs)
  v.db.close()
  rmSync(base, { recursive: true, force: true })
})

t('verify 报 new 和 missing', () => {
  const { base, data, put } = setup()
  const v = openVault(join(base, 'home'))
  addRoot(v, 'data', data)
  register(v, [data])
  put('notes/新增文件.md', 'n'.repeat(77))
  rmSync(join(data, 'README.md'))
  const r = verify(v)
  eq(r.new.length, 1, '新增数')
  eq(r.missing.length, 1, '缺失数')
  v.db.close()
  rmSync(base, { recursive: true, force: true })
})

t('verify 能重定位改名文件', () => {
  const { base, data } = setup()
  const v = openVault(join(base, 'home'))
  addRoot(v, 'data', data)
  register(v, [data])
  const from = join(data, '计算机图形学', '实验3', '三角形光栅化.md')
  const to = join(data, '计算机图形学', '实验3', '改名后.md')
  renameSync(from, to)
  const r = verify(v)
  eq(r.moved.length, 1, '重定位数')
  eq(r.moved[0].to, '计算机图形学/实验3/改名后.md', '新路径')
  v.db.close()
  rmSync(base, { recursive: true, force: true })
})

t('导出后删库再导入，检索结果一致', () => {
  const { base, data } = setup()
  const home = join(base, 'home')
  const v = openVault(home)
  addRoot(v, 'data', data)
  register(v, [data])
  const before = find(v, '实验')
  const exp = exportManifest(v)
  eq(exp.count, 6, '清单条数')
  v.db.close()

  const home2 = join(base, 'home2')
  const v2 = openVault(home2)
  addRoot(v2, 'data', data)
  importManifest(v2, exp.file)
  const after = find(v2, '实验')
  eq(after.length, before.length, '重建后条数')
  eq(after[0].rel_path, before[0].rel_path, 'Top1 路径')
  v2.db.close()
  rmSync(base, { recursive: true, force: true })
})

t('stats 统计总数和分布', () => {
  const { base, data } = setup()
  const v = openVault(join(base, 'home'))
  addRoot(v, 'data', data)
  register(v, [data])
  const s = stats(v)
  eq(s.total, 6, '总数')
  eq(s.missing, 0, '缺失数')
  ok(s.byExt.length >= 2, '扩展名种类')
  v.db.close()
  rmSync(base, { recursive: true, force: true })
})

t('根外文件计入 outside', () => {
  const base = mkdtempSync(join(tmpdir(), 'vault-'))
  const data = join(base, 'data')
  mkdirSync(data, { recursive: true })
  writeFileSync(join(data, 'in.txt'), 'x')
  const outsideDir = join(base, 'other')
  mkdirSync(outsideDir, { recursive: true })
  writeFileSync(join(outsideDir, 'out.txt'), 'y')
  const v = openVault(join(base, 'home'))
  addRoot(v, 'data', data)
  const r = register(v, [data, outsideDir])
  eq(r.outside, 1, '根外数')
  v.db.close()
  rmSync(base, { recursive: true, force: true })
})

console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
