// 身份卡插件自检：注入主路径 + 空库边界 + 通用工具全部 action。
// 复跑：node selftest.mjs（在仓库根目录）
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from './index.js'

// 每次运行用一份临时卡库，免得读写真实的 ~/.dsh/cards（尤其是 .claims.json）
const REAL_CARDS = join(homedir(), '.dsh', 'cards')
const CARDS = mkdtempSync(join(tmpdir(), 'cards-root-'))
for (const id of ['lab-report', 'code', 'meta']) {
  const from = join(REAL_CARDS, id)
  if (existsSync(from)) cpSync(from, join(CARDS, id), { recursive: true })
}

const GOOD = `---
id: probe-card
name: 探测卡
version: 1
order: 20
trigger: [探针, 测试]
expire: [真实任务]
verify: "python check.py"
---

## 1. 你是谁

测试用。

## 2. 任务封装

**开工前**

1. 读一遍。

## 3. 输出要求

**风格**：第三人称。

可验规则：

1. 不出现第一人称。

## 4. 什么时候这张卡不管用

- 真实任务。

## 5. 样本

- 待填。
`

function makeHarness({ withTools = true, cardsDir = CARDS, userQuestions, libraryDir, libraryWarn, contract } = {}) {
  const captured = { section: null, tool: null }
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return () => typeof dispose === 'function' && dispose()
    },
    systemPrompt: {
      section(section) {
        captured.section = section
        return () => {}
      },
      async assemble() {
        return {
          sections: [{ name: 'identity-cards', text: 'abc' }],
          contexts: [],
          tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
          variables: {},
        }
      },
    },
  }
  if (withTools) {
    ctx.tools = {
      register(definition) {
        captured.tool = definition
        return () => {}
      },
    }
  }
  if (userQuestions) ctx.userQuestions = userQuestions
  ctx.get = name => (name === 'tools' ? ctx.tools : name === 'userQuestions' ? ctx.userQuestions : undefined)
  apply(ctx, {
    cardsDir,
    ...(libraryDir ? { libraryDir } : {}),
    ...(Number.isFinite(libraryWarn) ? { libraryWarn } : {}),
    ...(contract === false ? { contract: false } : {}),
  })
  return captured
}

let failures = 0
function check(name, fn) {
  try {
    fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}: ${error.message}`)
  }
}
const run = (tool, args) => Promise.resolve(tool.execute(args)).then(String)

// 主路径：真实卡库 + 注入
{
  const { section, tool } = makeHarness()
  const text = section ? section.text() : ''
  console.log('--- 注入内容 ---')
  console.log(text || '(空)')
  console.log('----------------')
  check('注册 section 且名字正确', () => {
    if (!section) throw new Error('没注册 section')
    if (section.name !== 'identity-cards') throw new Error('名字不对')
  })
  check('目录里有 lab-report', () => {
    if (!text.includes('lab-report')) throw new Error('没有 lab-report')
  })
  check('注入里带全局契约', () => {
    if (!text.includes('## 全局契约')) throw new Error('缺全局契约段')
    if (!text.includes('代码不写装饰线')) throw new Error('缺分割线规则')
    if (!text.includes('中间文件必须可枚举')) throw new Error('缺中间文件规则')
    if (!text.includes('业务规则进卡')) throw new Error('缺边界声明')
  })
  check('每卡只占一行且四段齐全', () => {
    const rows = text.split('\n').filter(line => line.startsWith('- '))
    if (rows.length === 0) throw new Error('一行都没有')
    for (const row of rows) {
      const fields = row.split('｜')
      if (fields.length !== 4) throw new Error(`字段数 ${fields.length}：${row}`)
    }
  })
  check('带失效条件', () => {
    if (!text.includes('不适用')) throw new Error('缺「不适用」列')
  })
  check('注册了 identity 工具', () => {
    if (!tool) throw new Error('没注册工具')
    if (tool.name !== 'identity') throw new Error('工具名不对')
  })

  const doctorOut = await run(tool, { action: 'doctor' })
  check('doctor 报版本/卡数/身份/加载记录', () => {
    if (!/插件版本：\d+\.\d+\.\d+/.test(doctorOut)) throw new Error(doctorOut.slice(0, 120))
    if (!doctorOut.includes('当前身份：无卡态')) throw new Error('缺当前身份')
    if (!doctorOut.includes('加载记录')) throw new Error('缺加载记录段')
  })
  const manualAll = await run(tool, { action: 'manual' })
  check('manual 输出分级表（只给组+卡名）', () => {
    if (!manualAll.includes('身份卡手册')) throw new Error(manualAll.slice(0, 80))
    if (!manualAll.includes('## ')) throw new Error('缺分组标题')
    if (manualAll.includes('适用：')) throw new Error('总表不该展开触发词')
  })
  const manualGroup = await run(tool, { action: 'manual', group: 'writing' })
  check('manual 单组展开触发词且不串组', () => {
    if (!manualGroup.includes('## writing')) throw new Error(manualGroup)
    if (!manualGroup.includes('适用：')) throw new Error('单组应展开触发词')
    if (manualGroup.includes('## dev')) throw new Error('混进了别的组')
  })
  const manualBad = await run(tool, { action: 'manual', group: 'nope' })
  check('manual 未知组给可用组列表', () => {
    if (!manualBad.includes('可用组')) throw new Error(manualBad)
  })
  const listOut = await run(tool, { action: 'list' })

  check('list 能列出 lab-report', () => {
    if (!listOut.includes('lab-report')) throw new Error(listOut.slice(0, 120))
  })
  const showOut = await run(tool, { action: 'show', id: 'lab-report' })
  check('show 给出注入摘要+全文', () => {
    if (!showOut.includes('注入摘要')) throw new Error('缺注入摘要')
    if (!showOut.includes('## 3. 输出要求')) throw new Error('缺全文')
  })
  const auditOut = await run(tool, { action: 'audit' })
  check('audit 报出各层开销', () => {
    if (!auditOut.includes('sections（1）')) throw new Error(auditOut.slice(0, 120))
    if (!auditOut.includes('tools（1）')) throw new Error('缺工具统计')
  })
  const verboseOut = await run(tool, { action: 'audit', verbose: true })
  check('audit verbose 返回每层全文', () => {
    if (!verboseOut.includes('=== 全文 ===')) throw new Error('缺全文段')
    if (!verboseOut.includes('abc')) throw new Error('缺 section 正文')
    if (verboseOut.includes('=== 全文 ===') === auditOut.includes('=== 全文 ===')) {
      throw new Error('verbose 开关没起作用')
    }
  })
}

// 写入：先坏后好，都在临时目录
{
  const sandbox = mkdtempSync(join(tmpdir(), 'cards-test-'))
  const { tool } = makeHarness({ cardsDir: sandbox })
  check('加载时写了 .plugin.log', () => {
    const log = readFileSync(join(sandbox, '.plugin.log'), 'utf8')
    if (!/v\d+\.\d+\.\d+/.test(log)) throw new Error(log)
  })
  const badOut = await run(tool, { action: 'write', id: 'probe-card', markdown: '没有 front-matter' })
  check('坏卡被拒绝且说明原因', () => {
    if (!badOut.includes('未写入')) throw new Error(badOut)
    if (existsSync(join(sandbox, 'probe-card', 'card.md'))) throw new Error('坏卡竟然写进去了')
  })
  const goodOut = await run(tool, { action: 'write', id: 'probe-card', markdown: GOOD })
  check('好卡写入成功', () => {
    if (!goodOut.includes('已写入')) throw new Error(goodOut)
    const onDisk = readFileSync(join(sandbox, 'probe-card', 'card.md'), 'utf8')
    if (!onDisk.includes('探测卡')) throw new Error('落盘内容不对')
  })
  const afterOut = await run(tool, { action: 'list' })
  check('写完后 list 立刻能看到', () => {
    if (!afterOut.includes('probe-card')) throw new Error(afterOut)
  })
  const sandboxExec = { agent: { id: 'sandbox-agent' } }
  const usedSandbox = await Promise.resolve(
    tool.execute({ action: 'use', id: 'probe-card' }, sandboxExec),
  ).then(String)
  check('卡级 verify 默认值会带出来', () => {
    if (!usedSandbox.includes('验收命令：python check.py')) throw new Error(usedSandbox.slice(-160))
  })
  rmSync(sandbox, { recursive: true, force: true })
}

// 边界：空库
{
  const { section, tool } = makeHarness({ cardsDir: 'C:\\__not_exist__\\cards' })
  const text = section ? section.text() : ''
  const out = await run(tool, { action: 'list' })
  check('空卡库不崩，给建卡提示', () => {
    if (!section) throw new Error('没注册 section')
    if (!text.includes('还没建卡')) throw new Error(`缺建卡提示，实际 ${JSON.stringify(text.slice(0, 40))}`)
    if (!text.includes('examples')) throw new Error('没指路到 examples')
  })
  check('空卡库时 list 给提示', () => {
    if (!out.includes('卡库为空')) throw new Error(out)
  })
}

// 契约可关：contract:false 时只注入卡片目录，不注入全局契约
{
  const off = makeHarness({ contract: false })
  const text = off.section ? off.section.text() : ''
  check('contract:false 关掉全局契约', () => {
    if (!text.includes('## 身份卡')) throw new Error('卡目录还在')
    if (text.includes('全局契约')) throw new Error('契约没关掉')
    if (text.includes('不写装饰线')) throw new Error('契约第 1 条还在')
  })
  const on = makeHarness()
  check('默认仍然注入全局契约', () => {
    if (!on.section.text().includes('全局契约')) throw new Error('默认被关掉了')
  })
}

// 边界：无 tools 服务 / 关闭
{
  const { section, tool } = makeHarness({ withTools: false })
  check('无 tools 服务时只注入、不报错', () => {
    if (!section) throw new Error('没注册 section')
    if (tool) throw new Error('不该注册工具')
  })
  const off = { section: null, tool: null }
  apply(
    {
      effect: fn => fn(),
      systemPrompt: { section: s => ((off.section = s), () => {}) },
      tools: { register: d => ((off.tool = d), () => {}) },
    },
    { enabled: false },
  )
  check('enabled:false 时什么都不注册', () => {
    if (off.section || off.tool) throw new Error('关闭状态下仍注册了东西')
  })
}

// 互斥：一个会话只认一张卡
{
  const { tool } = makeHarness()
  const exec = { agent: { id: 'session-A' } }
  const call = (args, e = exec) => Promise.resolve(tool.execute(args, e)).then(String)

  const before = await call({ action: 'current' })
  check('开局是默认卡', () => {
    if (!before.includes('默认卡')) throw new Error(before)
  })
  const used = await call({ action: 'use', id: 'lab-report' })
  check('默认卡 → 具体卡：自动认领并注入全文', () => {
    if (!used.includes('自动认领')) throw new Error(used.slice(0, 80))
    if (!used.includes('## 3. 输出要求')) throw new Error('正文没注入')
  })
  const again = await call({ action: 'use', id: 'lab-report' })
  check('同一张卡不重复注入', () => {
    if (!again.includes('不重复注入')) throw new Error(again)
  })
  const other = await call({ action: 'use', id: 'meta' })
  check('已认领时 use 另一张被拒', () => {
    if (!other.includes('不能直接换')) throw new Error(other)
  })
  const otherSession = await call({ action: 'current' }, { agent: { id: 'session-B' } })
  check('别的会话仍是默认卡', () => {
    if (!otherSession.includes('默认卡')) throw new Error(otherSession)
  })
  const now = await call({ action: 'current' })
  check('current 报出生效的卡', () => {
    if (!now.includes('lab-report')) throw new Error(now)
  })
  const released = await call({ action: 'release', id: 'lab-report' })
  check('不允许回到默认卡', () => {
    if (!released.includes('不允许')) throw new Error(released)
  })
  const stillMine = await call({ action: 'current' })
  check('release 之后身份没变', () => {
    if (!stillMine.includes('lab-report')) throw new Error(stillMine)
  })
  const noAsk = await call({ action: 'switch', id: 'meta' })
  check('没有确认服务时 switch 被拒', () => {
    if (!noAsk.includes('拿不到你的确认')) throw new Error(noAsk)
  })
  const cross = await call({ action: 'show', id: 'code' })
  check('锁定态也能看别的卡（访问不互斥）', () => {
    if (!cross.includes('代码开发')) throw new Error(cross.slice(0, 80))
  })
}

// 协作：related 只读参考、永不自动注入
{
  const { tool } = makeHarness()
  const exec = { agent: { id: 'collab' } }
  const call = (args, e = exec) => Promise.resolve(tool.execute(args, e)).then(String)

  const usedCode = await call({ action: 'use', id: 'code' })
  check('use 输出协作规则并列出 related', () => {
    if (!usedCode.includes('协作：related = meta、lab-report')) throw new Error(usedCode.slice(-200))
    if (!usedCode.includes('永不自动注入')) throw new Error('缺「永不自动注入」声明')
  })
  check('related 卡正文没有被自动注入', () => {
    if (usedCode.includes('第二人称对话')) throw new Error('meta 卡正文被带进来了')
  })

  const noCard = await call({ action: 'reference', id: 'meta' }, { agent: { id: 'collab-2' } })
  check('无卡态 reference 会标注', () => {
    if (!noCard.includes('当前无身份卡')) throw new Error(noCard.slice(0, 100))
  })

  const rel = await call({ action: 'reference', id: 'lab-report' })
  check('related 卡可参考并标注归属', () => {
    if (!rel.includes('属 code 的 related')) throw new Error(rel.slice(0, 100))
    if (!rel.includes('## 3. 输出要求')) throw new Error('没给出正文')
  })
  const still = await call({ action: 'current' })
  check('reference 不改变身份', () => {
    if (!still.includes('code')) throw new Error(still)
    if (still.includes('lab-report')) throw new Error('身份被改掉了')
  })

  await call({ action: 'switch', id: 'meta' }, { agent: { id: 'collab-3' } })
  const unrel = await call({ action: 'reference', id: 'lab-report' }, { agent: { id: 'collab-4' } })
  check('非 related 卡可看但降级标注', () => {
    if (!unrel.includes('当前无身份卡')) throw new Error(unrel.slice(0, 120))
  })
}

// verify：缺省要显式说出来，会话级可覆盖
{
  const { tool } = makeHarness()
  const call = (args, e) => Promise.resolve(tool.execute(args, e)).then(String)
  const noVerify = await call({ action: 'use', id: 'lab-report' }, { agent: { id: 'vA' } })
  check('无验收命令时显式说出来', () => {
    if (!noVerify.includes('没有验收命令')) throw new Error(noVerify.slice(-200))
  })
  const withVerify = await call(
    { action: 'use', id: 'lab-report', verify: 'python check.py' },
    { agent: { id: 'vB' } },
  )
  check('use 可带会话级 verify', () => {
    if (!withVerify.includes('验收命令：python check.py')) throw new Error(withVerify.slice(-160))
  })
  const cur = await call({ action: 'current' }, { agent: { id: 'vB' } })
  check('current 报出验收命令', () => {
    if (!cur.includes('python check.py')) throw new Error(cur)
  })
  const curOther = await call({ action: 'current' }, { agent: { id: 'vA' } })
  check('别的会话的 verify 不串', () => {
    if (curOther.includes('python check.py')) throw new Error(curOther)
  })
}

// clean：没有确认就绝不删除
{
  const sandbox = mkdtempSync(join(tmpdir(), 'clean-test-'))
  mkdirSync(join(sandbox, '_junk'), { recursive: true })
  writeFileSync(join(sandbox, '_junk', 'a.txt'), 'x')
  writeFileSync(join(sandbox, 'keep.txt'), 'y')
  const { tool } = makeHarness({ cardsDir: sandbox })
  const call = args => Promise.resolve(tool.execute(args, { agent: { id: 'c1' } })).then(String)

  const out = await call({ action: 'clean', path: sandbox })
  check('clean 只列 _ 开头条目', () => {
    if (!out.includes('_junk')) throw new Error(out)
    if (out.includes('keep.txt')) throw new Error('把普通文件也列进来了')
  })
  check('没有 userQuestions 时绝不删除', () => {
    if (!out.includes('未删除')) throw new Error(out)
    if (!existsSync(join(sandbox, '_junk', 'a.txt'))) throw new Error('竟然删了')
    if (!existsSync(join(sandbox, 'keep.txt'))) throw new Error('普通文件被删了')
  })
  const noPath = await call({ action: 'clean' })
  check('clean 缺 path 时明确报错', () => {
    if (!noPath.includes('需要 path 参数')) throw new Error(noPath)
  })
  const guarded = await call({ action: 'clean', path: homedir() })
  check('关键目录被拒绝', () => {
    if (!guarded.includes('拒绝')) throw new Error(guarded)
  })
  const missing = await call({ action: 'clean', path: join(sandbox, '__not_exist__') })
  check('不存在的目录报读不了', () => {
    if (!missing.includes('读不了目录')) throw new Error(missing)
  })
  check('每项都说明来源与用途', () => {
    if (!out.includes('来源与用途：')) throw new Error(out)
    if (!out.includes('来源未标注')) throw new Error('未知条目应有兜底说明')
  })
  const annotated = await call({ action: 'clean', path: sandbox, notes: { _junk: '本次生成的测试数据' } })
  check('notes 能覆盖来源说明', () => {
    if (!annotated.includes('本次生成的测试数据')) throw new Error(annotated)
    if (annotated.includes('来源未标注')) throw new Error('应被 notes 覆盖')
  })
  const hinted = mkdtempSync(join(tmpdir(), 'clean-hint-'))
  mkdirSync(join(hinted, '_pages'), { recursive: true })
  const hintedOut = await call({ action: 'clean', path: hinted })
  check('按名字能猜出渲染页用途', () => {
    if (!hintedOut.includes('渲染出来的页面')) throw new Error(hintedOut)
  })
  rmSync(hinted, { recursive: true, force: true })
  rmSync(sandbox, { recursive: true, force: true })
}

// switch：有确认才换；取消就保持不变
{
  const answers = []
  const fake = {
    async ask(request) {
      const q = request.questions[0]
      answers.push(q.question)
      return { answers: [{ id: q.id, selected: [request.__pick || '切换'] }] }
    },
  }
  const { tool } = makeHarness({ userQuestions: fake })
  const exec = { agent: { id: 'sw-1' } }
  const call = (args, e = exec) => Promise.resolve(tool.execute(args, e)).then(String)

  await call({ action: 'use', id: 'lab-report' })
  const switched = await call({ action: 'switch', id: 'meta' })
  check('switch 会先问用户再换', () => {
    if (!answers[0] || !answers[0].includes('从 lab-report 切到 meta')) throw new Error(JSON.stringify(answers))
    if (!switched.includes('已切至身份卡：meta')) throw new Error(switched.slice(0, 120))
    if (!switched.includes('lab-report → meta')) throw new Error('缺切换来源')
    if (!switched.includes('## 3. 输出要求')) throw new Error('新卡正文没注入')
  })
  const cur = await call({ action: 'current' })
  check('switch 后 current 是新卡', () => {
    if (!cur.includes('meta')) throw new Error(cur)
  })
  const dup = await call({ action: 'switch', id: 'meta' })
  check('切到同一张不重复问', () => {
    if (!dup.includes('无需切换')) throw new Error(dup)
  })
  const back = await call({ action: 'switch', id: 'lab-report' })
  check('可以从一张卡切回去（换卡不是单向）', () => {
    if (!back.includes('已切至身份卡：lab-report')) throw new Error(back.slice(0, 120))
  })
}

// 自动切卡：不问；第三次起必须问
{
  const { tool } = makeHarness()
  const exec = { agent: { id: 'auto-1' } }
  const call = args => Promise.resolve(tool.execute(args, exec)).then(String)
  await call({ action: 'use', id: 'lab-report' })
  const a1 = await call({ action: 'switch', id: 'meta', auto: true })
  check('auto 切换不弹窗，且声明已切至身份卡', () => {
    if (!a1.includes('已切至身份卡：meta')) throw new Error(a1.slice(0, 120))
    if (!a1.includes('自动切换，本会话第 1 次')) throw new Error('缺次数声明')
    if (!a1.includes('判据自此刻起作废')) throw new Error('旧卡未作废')
  })
  const a2 = await call({ action: 'switch', id: 'code', auto: true })
  check('第二次 auto 仍然放行', () => {
    if (!a2.includes('已切至身份卡：code')) throw new Error(a2.slice(0, 120))
  })
  const a3 = await call({ action: 'switch', id: 'meta', auto: true })
  check('第三次 auto 起改用确认流程', () => {
    if (!a3.includes('拿不到你的确认')) throw new Error(a3.slice(0, 120))
  })
}

// 持久化：认领写盘；新 harness（模拟进程重启）能读回来
{
  const exec = { agent: { id: 'persist-1' } }
  const harness = makeHarness()
  await Promise.resolve(harness.tool.execute({ action: 'use', id: 'meta' }, exec))
  const onDisk = JSON.parse(readFileSync(join(CARDS, '.claims.json'), 'utf8'))
  check('认领写进了 .claims.json', () => {
    if (!onDisk['persist-1'] || onDisk['persist-1'].id !== 'meta') throw new Error(JSON.stringify(onDisk))
  })

  onDisk['disk-sess'] = { id: 'code', at: new Date().toISOString(), verify: '' }
  writeFileSync(join(CARDS, '.claims.json'), JSON.stringify(onDisk, null, 2), 'utf8')
  const restarted = makeHarness()
  const after = await Promise.resolve(
    restarted.tool.execute({ action: 'current' }, { agent: { id: 'disk-sess' } }),
  ).then(String)
  check('重启后能从盘里读回认领', () => {
    if (!after.includes('code')) throw new Error(after)
    if (after.includes('默认卡')) throw new Error('退回默认卡了')
  })
}

// library：查索引 + 提交更新
{
  const root = mkdtempSync(join(tmpdir(), 'lib-test-'))
  const proj = join(root, 'proj')
  mkdirSync(proj, { recursive: true })
  writeFileSync(join(proj, 'INDEX.md'), '# 项目说明\n', 'utf8')
  const plain = join(root, 'plain')
  mkdirSync(plain, { recursive: true })
  const index = [
    '# 资料索引',
    '',
    '| 名称 | 路径 | 类型 | 用途 | 最后确认 |',
    '|---|---|---|---|---|',
    '| 图形学风格包 | `D:\\c_code\\computer_graph\\reports\\style_compare` | 目录 | 正反例与规则源 | 2026-11-06 |',
    '| 旧实验 | `D:\\old\\exp` | 目录 | 过期样本 | 2025-01-01 |',
    `| 有说明的项目 | \`${proj}\` | 目录 | 带 INDEX.md | 2026-11-06 |`,
    `| 没说明的项目 | \`${plain}\` | 目录 | 空目录 | 2026-11-06 |`,
    '',
  ].join('\n')
  writeFileSync(join(root, 'index.md'), index, 'utf8')
  const { tool } = makeHarness({ libraryDir: root, libraryWarn: 2 })
  const call = args => Promise.resolve(tool.execute(args, { agent: { id: 'lib-1' } })).then(String)

  const hit = await call({ action: 'library', mode: 'find', query: '图形学' })
  check('library find 命中并给出路径', () => {
    if (!hit.includes('style_compare')) throw new Error(hit)
    if (!hit.includes('用途：正反例与规则源')) throw new Error('缺用途')
  })
  const stale = await call({ action: 'library', mode: 'find', query: '旧实验' })
  check('超过 90 天的条目标可能过期', () => {
    if (!stale.includes('可能过期')) throw new Error(stale)
  })
  const miss = await call({ action: 'library', mode: 'find', query: '不存在的东西' })
  check('library find 未命中时说清楚', () => {
    if (!miss.includes('没有匹配')) throw new Error(miss)
  })

  const r1 = await call({ action: 'library', mode: 'report', item: '图形学风格包', change: '内容大改', note: '新增 v3 报告' })
  check('library report 写入更新表', () => {
    if (!r1.includes('已记录')) throw new Error(r1)
    const txt = readFileSync(join(root, 'updates.md'), 'utf8')
    if (!txt.includes('内容大改')) throw new Error('没写进文件')
    if (!txt.includes('lib-1')) throw new Error('没记提交者')
  })
  const r2 = await call({ action: 'library', mode: 'report', item: '旧实验', change: '路径失效', note: '读不到' })
  check('更新表到阈值时提醒合并', () => {
    if (!r2.includes('该切 librarian')) throw new Error(r2)
  })
  const bad = await call({ action: 'library', mode: 'report', item: 'x' })
  check('report 缺变更类型时拒绝', () => {
    if (!bad.includes('需要 change 参数')) throw new Error(bad)
  })
  const withDoc = await call({ action: 'library', mode: 'find', query: '有说明' })
  check('目录里有 INDEX.md 时带出入口', () => {
    if (!withDoc.includes('项目内说明')) throw new Error(withDoc)
    if (!withDoc.includes('INDEX.md')) throw new Error(withDoc)
  })
  const noDoc = await call({ action: 'library', mode: 'find', query: '没说明' })
  check('没有说明文档时不硬造提示', () => {
    if (noDoc.includes('项目内说明')) throw new Error(noDoc)
  })
  rmSync(root, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
