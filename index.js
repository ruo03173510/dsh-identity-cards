/**
 * 身份卡 v2
 *
 * 1) 把 ~/.dsh/cards 下每张卡的摘要注入系统提示（每卡一行）；
 * 2) 通用工具 `identity`，对所有卡生效：
 *      list     列出卡
 *      show     看某张卡的注入摘要 + 全文
 *      write    新增/修改卡（带结构校验）
 *      use      认领一张卡并把**全文注入一次**（互斥：一个会话只认一次）
 *      current  看本会话当前生效的卡
 *      release  解除认领（换卡前必须显式做，防误换）
 *      audit    审计当前注入的全部提示层
 *
 * 互斥靠会话级状态（按 agent id）。任何一步出错都静默降级，绝不阻断会话。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

export const name = 'identity-cards'
export const inject = ['systemPrompt', 'tools']

const CACHE_TTL_MS = 1500
let cache = { key: '', at: 0, text: '' }

const VERSION = '1.0.1'

/** 每次加载写一行。分 start / done 两段，才能区分「没跑」和「跑了但没拿到 tools」。 */
function logLoad(dir, detail) {
  try {
    appendFileSync(join(dir, '.plugin.log'), `${new Date().toISOString()} v${VERSION} ${detail}\n`, 'utf8')
  } catch {
    /* 日志失败不影响运行 */
  }
}

/** 会话级认领表：一个会话一张卡。进程内有效，重启后需重新认卡（有意为之）。 */
const claims = new Map()

/** 认领落盘，会话恢复/进程重启后还能找回来。 */
function loadClaims(dir) {
  try {
    const raw = JSON.parse(readFileSync(join(dir, '.claims.json'), 'utf8'))
    if (raw && typeof raw === 'object') {
      for (const [key, value] of Object.entries(raw)) {
        if (value && value.id) claims.set(key, value)
      }
    }
  } catch {
    /* 首次运行没有文件 */
  }
}

function saveClaims(dir) {
  try {
    const out = {}
    for (const [key, value] of claims) out[key] = value
    writeFileSync(join(dir, '.claims.json'), JSON.stringify(out, null, 2), 'utf8')
  } catch {
    /* 落盘失败就只留内存 */
  }
}
const claimKey = exec => {
  try {
    return String(exec?.agent?.id ?? 'global')
  } catch {
    return 'global'
  }
}

function cardsRoot(config) {
  if (typeof config?.cardsDir === 'string' && config.cardsDir) return config.cardsDir
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'cards')
}

function splitList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  if (typeof value !== 'string') return []
  const trimmed = value.trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map(item => item.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
  }
  return trimmed ? [trimmed] : []
}

function parseFrontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) return null
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue
    const at = line.indexOf(':')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    meta[key] = line.slice(at + 1).trim()
  }
  return meta
}

function collect(dir, max) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const cards = []
  for (const entry of entries) {
    if (cards.length >= max) break
    const file = join(dir, entry, 'card.md')
    try {
      if (!statSync(file).isFile()) continue
      const raw = readFileSync(file, 'utf8')
      const meta = parseFrontMatter(raw)
      if (!meta || !meta.id || !meta.name) continue
      cards.push({
        id: String(meta.id),
        name: String(meta.name),
        order: Number(meta.order) || 0,
        trigger: splitList(meta.trigger),
        expire: splitList(meta.expire),
        version: String(meta.version || ''),
        group: String(meta.group || 'general'),
        related: splitList(meta.related),
        verify: String(meta.verify || '').replace(/^["']|["']$/g, '').trim(),
        path: file,
        raw,
      })
    } catch {
      /* 单张卡坏了不连坐 */
    }
  }
  return cards.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
}

const joinOrDash = list => (list.length ? list.join('、') : '—')

function render(dir, max, opts = {}) {
  const cards = collect(dir, max)
  if (!cards.length) {
    return (
      '## 身份卡（还没建卡）\n' +
      `卡库是空的：${dir}\n` +
      '让智能体建一张最快：`identity write id=<卡名>` 会生成骨架，填完 trigger/expire 和四节正文就行。' +
      '也可以把仓库 `examples/minimal/` 整个目录拷进来。'
    )
  }
  const base = dir.replace(/\\/g, '/')
  const lines = ['## 身份卡（开工前必须先认卡）', '可用卡：']
  for (const card of cards) {
    lines.push(
      `- ${card.id}｜${card.name}｜适用：${joinOrDash(card.trigger)}｜不适用：${joinOrDash(card.expire)}`,
    )
  }
  lines.push(
    `规程：会话默认是「默认卡」（未指定身份）。任务明确后直接用 \`use\` 认领合适的卡——自动，只需告知用户；` +
      `之后换卡用 \`switch\`（带 auto 可不问，一个会话最多自动两次，第三次起会问）；不允许回到默认卡。` +
      `**任何切卡后，回复第一行必须是「已切至身份卡：<id>」；旧卡判据自此刻起作废。** 不要用 read 重复读卡全文。` +
      `通用命令：list / manual / show / reference / write / use / switch / current / audit / doctor / clean / library。` +
      `互斥只限制「注入」，不限制「访问」：想参考别的卡用 reference <id>（会标注、不改身份），show 只看不标注。`,
  )
  if (opts.contract === false) return lines.join('\n')
  lines.push(
    '',
    '## 全局契约（不随卡变化，优先级高于模型自身习惯）',
    '1. 代码不写装饰线：`=====` / `-----` / `*****` 这类分割线一律不要；分区用空行和函数，注释紧贴代码、单行、说「为什么」。',
    '2. 文档不写分隔线，不用 Word 域、自动目录、自动题注（黑方块的来源）。',
    '3. 不写「首先 / 其次 / 最后 / 综上所述 / 总的来说」这类模板化连接词。',
    '4. 结论先行：不在结尾堆总结段和客套，不复述对方刚说过的话。',
    '5. 中间文件必须可枚举：**本次生成、只为产出结果服务**的文件（不含开始时已有的输入和最终成果），一律以 `_` 开头或放进 `_tmp/`；交付物不带前缀。',
    '6. 改了东西就要有可复跑的验证证据（把改动退回后它应当失败）；纯讨论、判断、评审不写验证行。',
    '7. 新建或大修资源必须登记：调用 `identity` 的 `library` 动作，mode=report，一句话说明这是什么、放哪、给谁用。判据：**三个月后你还找得到吗？**',
    '   找东西：**不确定在哪个盘/项目**时先 `library` mode=find；**已经在某个项目里**就直接列目录，别查索引。按索引访问发现不对，report 一条「路径失效」。',
    '> 只放跨卡、反模型默认习惯的规则；业务规则进卡，别往这里加。',
  )
  return lines.join('\n')
}

function dirSize(target) {
  let total = 0
  let files = 0
  const walk = p => {
    let entries
    try {
      entries = readdirSync(p, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(p, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        try {
          total += statSync(full).size
          files += 1
        } catch {
          /* 读不到就跳过 */
        }
      }
    }
  }
  let isDir = false
  try {
    isDir = statSync(target).isDirectory()
  } catch {
    return { total: 0, files: 0 }
  }
  if (isDir) walk(target)
  else {
    try {
      total = statSync(target).size
      files = 1
    } catch {
      /* ignore */
    }
  }
  return { total, files }
}

const formatSize = n =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`

/** 按名字猜来源与用途。猜不准返回空串，交给调用方补。 */
const NAME_HINTS = [
  [/__pycache__|\.pyc$/i, 'Python 字节码缓存，运行时会自动重建'],
  [/page|render|截图|shot/i, '渲染出来的页面或截图，由产物重新导出即可恢复'],
  [/build|dist|bundle/i, '构建脚本与中间产物，服务于本次交付'],
  [/outline|extract|ocr|text|pdf2/i, '从源文件里提取的文本，可重新提取'],
  [/tmp|temp|cache/i, '临时缓存，删掉不影响产物'],
  [/\.bak|backup|old/i, '改动前的备份副本'],
]

function describeName(name) {
  for (const [pattern, note] of NAME_HINTS) {
    if (pattern.test(name)) return note
  }
  return ''
}

/** 关键目录不参与清理：盘符根、用户主目录、DSH_HOME。 */
function protectPath(target) {
  const resolved = resolve(target).toLowerCase()
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const guards = [resolve(process.env.SystemDrive ? `${process.env.SystemDrive}\\` : '\\'), resolve(homedir()), resolve(dshHome)]
  for (const guard of guards) {
    if (resolve(guard).toLowerCase() === resolved) return `拒绝：${target} 是关键目录`
  }
  return ''
}

const CARD_ID = /^[a-z0-9][a-z0-9-]*$/

function validate(markdown) {
  const problems = []
  const meta = parseFrontMatter(markdown)
  if (!meta) problems.push('缺少 front-matter（--- 包裹的头部）')
  else {
    for (const key of ['id', 'name', 'trigger', 'expire']) {
      if (!meta[key]) problems.push(`front-matter 缺 ${key}`)
    }
    if (meta.id && !CARD_ID.test(meta.id)) problems.push('id 只能用小写字母、数字、连字符')
    if (meta.expire && splitList(meta.expire).length === 0) problems.push('expire 必须至少 1 条')
  }
  const sections = [...markdown.matchAll(/^##\s+/gm)].length
  if (sections < 4) problems.push(`正文只有 ${sections} 段，规范要求 5 段`)
  return { meta, problems }
}

export function apply(ctx, config = {}) {
  if (config && config.enabled === false) return

  const dir = cardsRoot(config)
  const max = Number.isFinite(config?.maxCards) ? config.maxCards : 8
  const contractEnabled = config?.contract !== false
  const order = Number.isFinite(config?.order) ? config.order : 40

  loadClaims(dir)
  logLoad(dir, `start cards=${collect(dir, max).length}`)

  const text = () => {
    try {
      const key = `${dir}|${max}|${contractEnabled}`
      const now = Date.now()
      if (cache.key === key && now - cache.at < CACHE_TTL_MS) return cache.text
      const value = render(dir, max, { contract: contractEnabled })
      cache = { key, at: now, text: value }
      return value
    } catch {
      return ''
    }
  }

  let dispose
  try {
    dispose = ctx.systemPrompt.section({ name: 'identity-cards', order, text })
  } catch (error) {
    logLoad(dir, `section-failed: ${error?.message ?? error}`)
  }
  if (typeof dispose === 'function' && typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => dispose)
    } catch {
      /* 卸载清理失败不影响运行 */
    }
  }

  let tools
  try {
    tools = typeof ctx.get === 'function' ? ctx.get('tools') : ctx.tools
  } catch {
    tools = undefined
  }
  if (!tools || typeof tools.register !== 'function') {
    logLoad(dir, 'tools-missing')
    return
  }

  const listAction = () => {
    const cards = collect(dir, max)
    if (!cards.length) return `卡库为空：${dir}`
    const rows = cards.map(card => {
      // 只看样本节：卡正文里教「检查占位符」不算自己有空位。
      const sample = (card.raw.split(/^##\s*5\.[^\n]*$/m)[1] || '')
      const filled = /待填/.test(sample) ? '（有未填占位）' : ''
      return `${card.id}｜${card.name}｜v${card.version || '?'}｜适用：${joinOrDash(card.trigger)}｜不适用：${joinOrDash(card.expire)}${filled}\n  ${card.path}`
    })
    return `共 ${cards.length} 张卡（上限 ${max}）：\n\n${rows.join('\n')}`
  }

  const showAction = (id) => {
    if (!id) return '需要 id 参数'
    const card = collect(dir, max).find(item => item.id === id)
    if (!card) return `没有这张卡：${id}`
    const injection = render(dir, max)
      .split('\n')
      .filter(line => line.includes(`- ${id}｜`))
      .join('\n')
    return `# ${card.name}（${card.id}）\n\n注入摘要（目录里那一行）：\n${injection}\n\n全文：\n\n${card.raw}`
  }

  /** 不给正文时给一份骨架——模型照着填，比让它凭空想格式可靠。 */
  const cardSkeleton = (id, name = '') => {
    const title = name || id
    return [
      '---',
      `id: ${id}`,
      `name: ${title}`,
      'version: 1',
      'order: 50',
      'group: general',
      'trigger: []',
      'expire: []',
      '---',
      '',
      `# ${title} · 身份卡`,
      '',
      '## 1. 你是谁',
      '',
      '一句话说清这张卡扮演什么角色。',
      '',
      '## 2. 任务封装',
      '',
      '**开工前**',
      '',
      '1. 说清要改什么、验收判据是什么。',
      '',
      '**收尾前**',
      '',
      '1. 给一条能复跑的证据。',
      '',
      '## 3. 输出要求',
      '',
      '**交付物**：…',
      '',
      '**格式**：…',
      '',
      '**风格**：…',
      '',
      '## 4. 什么时候这张卡不管用',
      '',
      '- …',
      '',
      '## 5. 样本',
      '',
      '- 正例：…（写路径，别复制内容）',
      '',
    ].join('\n')
  }

  const writeAction = (id, markdown) => {
    if (!id) return '需要 id 参数'
    if (!CARD_ID.test(id)) return 'id 只能用小写字母、数字、连字符'
    const isSkeleton = !(typeof markdown === 'string' && markdown.trim())
    const body = isSkeleton ? cardSkeleton(id) : markdown
    // 骨架本来就带着空字段，不该被校验拦下；正式卡才校验。
    if (!isSkeleton) {
      const { meta, problems } = validate(body)
      if (meta?.id && meta.id !== id) problems.push(`front-matter 的 id（${meta.id}）与参数 id（${id}）不一致`)
      if (problems.length) return `未写入，先修这些问题：\n- ${problems.join('\n- ')}`
    }
    try {
      mkdirSync(join(dir, id), { recursive: true })
      writeFileSync(join(dir, id, 'card.md'), body, 'utf8')
      cache = { key: '', at: 0, text: '' }
      const tail = isSkeleton
        ? '\n\n骨架已落盘。`trigger` / `expire` 还空着——它们决定这张卡判不判得对，填上之后才会被认领。'
        : ''
      return `已写入 ${join(dir, id, 'card.md')}${tail}`
    } catch (error) {
      return `写入失败：${error.message}`
    }
  }

  const askUser = async (exec, question) => {
    const questions = typeof ctx.get === 'function' ? ctx.get('userQuestions') : undefined
    if (!questions || typeof questions.ask !== 'function') {
      return { ok: false, reason: 'userQuestions 服务不可用，拿不到你的确认' }
    }
    try {
      const answer = await questions.ask({ agent: exec?.agent, questions: [question] })
      return { ok: true, selected: answer?.answers?.[0]?.selected ?? [] }
    } catch (error) {
      return { ok: false, reason: `确认弹窗失败——${error?.message ?? error}` }
    }
  }

  const cardBody = (card, effective) =>
    `---\n${card.raw}\n---\n\n` +
    `按第 2 节（任务封装）执行；任务变了用 identity switch <id>（会先问你）。\n\n` +
    `协作：related = ${card.related.length ? card.related.join('、') : '无'}（只读参考，永不自动注入）。\n` +
    `判据冲突时以本卡为准，并在输出里注明「按 X 卡」。\n\n` +
    (effective ? `验收命令：${effective}（收尾前必须跑，命中即失败）` : '验收：本卡没有验收命令，判据只能靠自觉。')

  /** 默认卡 → 具体卡：自动，只告知。 */
  const useAction = (exec, id, verify) => {
    if (!id) return '需要 id 参数'
    const key = claimKey(exec)
    const existing = claims.get(key)
    const card = collect(dir, max).find(item => item.id === id)
    if (!card) return `没有这张卡：${id}。先 identity list 看可用的。`
    if (existing && existing.id === id) return `卡 ${id} 已生效（认领于 ${existing.at}），全文不重复注入。`
    if (existing) return `当前是 ${existing.id}，不能直接换。换卡用 identity switch id=${id}（会先问你）。`
    const effective = String(verify || card.verify || '').trim()
    claims.set(key, { id, at: new Date().toISOString(), verify: effective, switches: 0 })
    saveClaims(dir)
    return `已切至身份卡：${card.id}（${card.name}）｜默认卡 → 具体卡，自动认领，不需你确认。\n\n${cardBody(card, effective)}`
  }

  /** 具体卡 → 具体卡：auto 时不必弹窗，但第 3 次起必须问。 */
  const switchAction = async (exec, id, auto) => {
    if (!id) return '需要 id 参数'
    const key = claimKey(exec)
    const existing = claims.get(key)
    if (!existing) return useAction(exec, id)
    if (existing.id === id) return `已经在 ${id}，无需切换。`
    const card = collect(dir, max).find(item => item.id === id)
    if (!card) return `没有这张卡：${id}。先 identity manual 查手册。`
    const used = Number(existing.switches) || 0
    const needAsk = !auto || used >= 2
    if (needAsk) {
      const confirm = await askUser(exec, {
        id: 'switch',
        header: '切换身份卡',
        question: `从 ${existing.id} 切到 ${id}（${card.name}）？`,
        detail: '旧卡判据即刻作废；它的全文还留在上下文里，但只当背景。',
        options: [
          { label: '切换', description: `改为 ${id}` },
          { label: '取消', description: `继续用 ${existing.id}` },
        ],
      })
      if (!confirm.ok) return confirm.reason
      if (!confirm.selected.includes('切换')) return `已取消，继续用 ${existing.id}。`
    }
    const effective = String(card.verify || '').trim()
    claims.set(key, { id, at: new Date().toISOString(), verify: effective, switches: used + 1 })
    saveClaims(dir)
    const how = auto ? `自动切换，本会话第 ${used + 1} 次` : '经你确认'
    return (
      `已切至身份卡：${id}（${card.name}）｜${existing.id} → ${id}，${how}\n` +
      `旧卡 ${existing.id} 的判据自此刻起作废——上下文里还有它的全文，但只当背景，不再作为验收标准。\n\n` +
      cardBody(card, effective)
    )
  }

  const currentAction = (exec) => {
    const claim = claims.get(claimKey(exec))
    if (!claim) return '当前是默认卡（未指定身份）。任务明确后用 identity use <id> 自动认领。'
    const card = collect(dir, max).find(item => item.id === claim.id)
    const verifyLine = claim.verify ? `｜验收：${claim.verify}` : '｜验收：未指定'
    return `本会话生效：${claim.id}${card ? `（${card.name}）` : '（卡文件已不存在）'}｜认领于 ${claim.at}${verifyLine}`
  }

  /** 默认卡是"未开始"状态，不允许回退——全文已经在上下文里，撤不回来。 */
  const releaseAction = () => '不允许回到默认卡：卡的全文已经进了上下文，撤不回来。要换身份用 identity switch <id>。'

  const referenceAction = (exec, id) => {
    if (!id) return '需要 id 参数'
    const cards = collect(dir, max)
    const card = cards.find(item => item.id === id)
    if (!card) return `没有这张卡：${id}。先 identity manual 查手册。`
    const claim = claims.get(claimKey(exec))
    const active = claim ? cards.find(item => item.id === claim.id) : undefined

    let header
    if (!active) {
      header = `【参考卡 ${card.name}（${id}）· 当前无身份卡，仅供参考；开工前先 use 认领身份】`
    } else if (active.id === id) {
      header = `【就是当前生效的卡 ${id}】`
    } else if (active.related.includes(id)) {
      header = `【参考卡 ${card.name}（${id}）· 属 ${active.id} 的 related，只读参考，不覆盖 ${active.id} 的判据】`
    } else {
      header = `【参考卡 ${card.name}（${id}）· 不在 ${active.id} 的 related 里，仅供参考；判据冲突时以 ${active.id} 为准】`
    }

    return (
      `${header}\n\n` +
      `---\n${card.raw}\n---\n\n` +
      `读完了：身份仍是 ${active ? active.id : '无卡'}。要用其中的具体做法，先说明「按 ${id} 卡」再执行；不要把它当成本卡的一部分。`
    )
  }

  /** 扫 `_` 开头的条目，弹窗让用户确认后删除。没有确认就绝不删。 */
  // ---------------------------------------------------------------- 资料索引
  const libraryRoot = () =>
    (typeof config?.libraryDir === 'string' && config.libraryDir) ||
    join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'library')

  const readIndexRows = () => {
    const file = join(libraryRoot(), 'index.md')
    let raw = ''
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      return { file, rows: [] }
    }
    const rows = []
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim().startsWith('|')) continue
      const cells = line.split('|').slice(1, -1).map(cell => cell.trim())
      if (cells.length < 4) continue
      if (cells[0] === '名称' || /^[-:]+$/.test(cells[0])) continue
      rows.push(cells)
    }
    return { file, rows }
  }

  const daysSince = text => {
    const d = new Date(text)
    if (Number.isNaN(d.getTime())) return null
    return Math.floor((Date.now() - d.getTime()) / 86400000)
  }

  const ageFlag = text => {
    const days = daysSince(text)
    if (days === null) return '[未标确认日]'
    if (days > 90) return `[未确认 ${days} 天，可能过期]`
    if (days > 30) return `[未确认 ${days} 天]`
    return ''
  }

  /** 目录条目下如果项目自带说明文档，就把入口带出来——索引只指路，不抄结构。 */
  const PROJECT_DOCS = ['INDEX.md', 'index.md', 'README.md', 'readme.md']
  const projectHints = cell => {
    const found = []
    for (const raw of String(cell || '').split('、')) {
      const p = raw.replace(/`/g, '').trim()
      if (!p) continue
      let isDir = false
      try {
        isDir = statSync(p).isDirectory()
      } catch {
        continue
      }
      if (!isDir) continue
      for (const doc of PROJECT_DOCS) {
        const full = join(p, doc)
        if (existsSync(full)) {
          found.push(full)
          break
        }
      }
    }
    return found
  }

  const libraryFind = query => {
    const { file, rows } = readIndexRows()
    if (!rows.length) return `索引还是空的：${file}\n让 librarian 卡扫一遍，或先手工加几行。`
    const q = String(query || '').trim().toLowerCase()
    const hits = q ? rows.filter(row => row.slice(0, 4).join(' ').toLowerCase().includes(q)) : rows
    if (!hits.length) return `索引里没有匹配「${query}」（共 ${rows.length} 条）。要么没登记，要么换个关键词。`
    const lines = hits.slice(0, 20).map(row => {
      const flag = ageFlag(row[4] || '')
      const base = `- ${row[0]}｜${row[1]}｜${row[2]}\n    用途：${row[3] || '—'}${flag ? '  ' + flag : ''}`
      const hints = projectHints(row[1])
      return hints.length ? `${base}\n${hints.map(h => `    ↳ 项目内说明：${h}（先读它）`).join('\n')}` : base
    })
    const tail = hits.length > 20 ? `\n…还有 ${hits.length - 20} 条，用更准的关键词。` : ''
    return `命中 ${hits.length} 条（索引共 ${rows.length} 条）：\n${lines.join('\n')}${tail}`
  }

  const libraryReport = (exec, item, change, note) => {
    if (!item) return '需要 item 参数：材料名或路径'
    if (!change) return '需要 change 参数：新建 / 移动 / 改名 / 删除 / 内容大改 / 路径失效'
    const root = libraryRoot()
    const file = join(root, 'updates.md')
    const now = new Date()
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const cardId = claims.get(claimKey(exec))?.id || '默认卡'
    const who = `${cardId}@${String(exec?.agent?.id ?? 'unknown').slice(0, 8)}`
    try {
      mkdirSync(root, { recursive: true })
      if (!existsSync(file)) {
        writeFileSync(file, '# 材料更新表\n\n| 时间 | 提交者 | 材料 | 变更 | 说明 |\n|---|---|---|---|---|\n', 'utf8')
      }
      appendFileSync(file, `| ${stamp} | ${who} | ${item} | ${change} | ${String(note || '').replace(/\|/g, '/')} |\n`, 'utf8')
    } catch (error) {
      return `写入失败：${error?.message ?? error}`
    }
    let pending = 0
    try {
      pending = readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .filter(line => line.trim().startsWith('|') && !/^\|\s*时间/.test(line) && !/^\|[-:\s|]+$/.test(line)).length
    } catch {
      pending = 0
    }
    const warnAt = Number.isFinite(config?.libraryWarn) ? config.libraryWarn : 50
    const tail =
      pending >= warnAt ? `\n\n⚠ 更新表已有 ${pending} 条，该切 librarian 卡合并进索引了。` : `（更新表 ${pending} 条）`
    return `已记录：${item}｜${change}${tail}`
  }

  const cleanAction = async (exec, target, notes = {}) => {
    if (!target) return '需要 path 参数：要扫描的目录'
    const resolved = resolve(target)
    const guard = protectPath(resolved)
    if (guard) return guard
    let entries
    try {
      entries = readdirSync(resolved, { withFileTypes: true })
    } catch (error) {
      return `读不了目录：${error?.message ?? error}`
    }
    const hits = []
    for (const entry of entries) {
      if (!entry.name.startsWith('_')) continue
      const full = join(resolved, entry.name)
      const { total, files } = dirSize(full)
      hits.push({ name: entry.name, full, dir: entry.isDirectory(), files, total })
    }
    if (!hits.length) return `${resolved}：没有 \`_\` 开头的中间件。`
    const sum = hits.reduce((acc, hit) => acc + hit.total, 0)
    const list = hits.map(hit => {
      const where = `${hit.full}${hit.dir ? '\\' : ''}（${hit.files} 文件，${formatSize(hit.total)}）`
      const note = notes[hit.name] || describeName(hit.name) || '来源未标注（`_` 前缀中间件，请确认是不是本次生成、只服务于产物的文件）'
      return `${where}\n    来源与用途：${note}`
    })
    const preview = `扫描 ${resolved}：\n- ${list.join('\n- ')}\n合计 ${hits.length} 项，${formatSize(sum)}`

    const questions = typeof ctx.get === 'function' ? ctx.get('userQuestions') : undefined
    if (!questions || typeof questions.ask !== 'function') {
      return `${preview}\n\n未删除：userQuestions 服务不可用，拿不到你的确认。`
    }
    let answer
    try {
      answer = await questions.ask({
        agent: exec?.agent,
        questions: [
          {
            id: 'clean',
            header: '清理中间件',
            question: `确认删除 ${hits.length} 项？共 ${formatSize(sum)}`,
            detail: list.join('\n'),
            options: [
              { label: '全部删除', description: '删掉上面列出的全部 _ 开头条目' },
              { label: '取消', description: '什么都不删' },
            ],
          },
        ],
      })
    } catch (error) {
      return `${preview}\n\n未删除：确认弹窗失败——${error?.message ?? error}`
    }
    const selected = answer?.answers?.[0]?.selected ?? []
    if (!selected.includes('全部删除')) return `${preview}\n\n你选择了取消，未删除。`

    const removed = []
    const failed = []
    for (const hit of hits) {
      try {
        rmSync(hit.full, { recursive: true, force: true })
        removed.push(hit.full)
      } catch (error) {
        failed.push(`${hit.full}：${error?.message ?? error}`)
      }
    }
    const done = `已删除 ${removed.length} 项，释放约 ${formatSize(sum)}。`
    return failed.length ? `${done}\n失败 ${failed.length} 项：\n- ${failed.join('\n- ')}` : done
  }

  const manualAction = (group) => {
    const cards = collect(dir, max)
    if (!cards.length) return `卡库为空：${dir}`
    const groups = new Map()
    for (const card of cards) {
      const key = card.group || 'general'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(card)
    }
    if (group && !groups.has(group)) {
      return `没有这一组：${group}。可用组：${[...groups.keys()].join(' / ')}`
    }
    const lines = [
      `# 身份卡手册（${cards.length} 张 / ${groups.size} 组）`,
      '先看表决定去哪一组，再进组看触发词，最后才 show/use 单张。',
      '认卡 use（注入，互斥一次）｜参考 show（不改身份）',
    ]
    for (const [key, items] of groups) {
      if (group && key !== group) continue
      lines.push('', `## ${key}（${items.length}）`)
      for (const card of items) {
        if (group) {
          lines.push(
            `- ${card.id}｜${card.name}｜适用：${joinOrDash(card.trigger)}｜不适用：${joinOrDash(card.expire)}`,
          )
          if (card.related.length) lines.push(`  related：${card.related.join('、')}`)
        } else {
          lines.push(`- ${card.id}｜${card.name}`)
        }
      }
    }
    return lines.join('\n')
  }

  const auditAction = async (verbose) => {
    try {
      const assembly = await ctx.systemPrompt.assemble({})
      const lines = []
      lines.push(`sections（${assembly.sections.length}）`)
      for (const section of assembly.sections) {
        lines.push(`  ${section.name}｜${section.text.length} 字`)
      }
      lines.push(`contexts（${assembly.contexts.length}）`)
      for (const context of assembly.contexts) {
        lines.push(`  ${context.name}｜${context.text.length} 字`)
      }
      lines.push(`tools（${assembly.tools.length}）`)
      const bySize = [...assembly.tools].sort((a, b) => b.description.length - a.description.length)
      for (const tool of bySize.slice(0, 12)) {
        lines.push(`  ${tool.name}｜描述 ${tool.description.length} 字`)
      }
      const total =
        assembly.sections.reduce((sum, item) => sum + item.text.length, 0) +
        assembly.contexts.reduce((sum, item) => sum + item.text.length, 0)
      const schemaChars = assembly.tools.reduce(
        (sum, item) => sum + item.description.length + JSON.stringify(item.parameters ?? {}).length,
        0,
      )
      lines.push(
        `合计：sections+contexts ${total} 字，工具 schema 约 ${schemaChars} 字，工具 ${assembly.tools.length} 个（全局视图）`,
      )
      if (verbose) {
        const clip = value =>
          value.length > 4000 ? `${value.slice(0, 4000)}\n…（截断，全文 ${value.length} 字）` : value
        lines.push('', '=== 全文 ===')
        for (const section of assembly.sections) {
          lines.push(`\n### ${section.name}（${section.text.length} 字）`, clip(section.text))
        }
        for (const context of assembly.contexts) {
          lines.push(`\n### context:${context.name}（${context.text.length} 字）`, clip(context.text))
        }
      }
      return lines.join('\n')
    } catch (error) {
      return `审计失败：${error.message}`
    }
  }

  const doctorAction = (exec) => {
    const cards = collect(dir, max)
    const claim = claims.get(claimKey(exec))
    const lines = [
      `插件版本：${VERSION}`,
      `卡目录：${dir}`,
      `卡：${cards.length} 张（上限 ${max}）`,
      `当前身份：${claim ? `${claim.id}（认领于 ${claim.at}）` : '无卡态'}`,
      `工具：identity ${typeof tools?.register === 'function' ? '已注册' : '未注册'}`,
    ]
    try {
      const rows = readFileSync(join(dir, '.plugin.log'), 'utf8').trim().split('\n').filter(Boolean)
      lines.push(`加载记录：${rows.length} 次，最近 3 次——`)
      for (const row of rows.slice(-3)) lines.push(`  ${row}`)
    } catch {
      lines.push('加载记录：无（本次启动后未加载过，或日志被清理）')
    }
    return lines.join('\n')
  }

  const definition = {
    name: 'identity',
    description:
      '身份卡通用命令：会话默认是「默认卡」（未指定身份）。use 从默认卡认领一张卡（自动，只告知，全文注入一次）；switch 从一张具体卡换到另一张（auto=true 可不问，前两次有效，第三次起仍会问你；切换后旧卡判据即刻作废，回复第一行须写「已切至身份卡：<id>」）；current 看当前生效的卡；release 不允许（回不到默认卡）；manual 分级表；list 列卡；show 看卡全文；reference 带标注参考另一张卡；write 新增或修改卡；audit 审计提示层；doctor 自检；clean 扫描 `_` 开头的中间件、弹窗确认后删除并逐项说明来源与用途；library 资料索引——mode=find 按关键词查路径（带未确认天数），mode=report 提交一条材料更新（新建/大修后必须报）。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['use', 'switch', 'current', 'release', 'list', 'show', 'manual', 'reference', 'write', 'audit', 'doctor', 'clean', 'library'],
        },
        id: { type: 'string', description: '卡 id（use / show / write / release 用）' },
        path: { type: 'string', description: 'clean 用：要扫描中间件的目录' },
        auto: { type: 'boolean', description: 'switch 用：true = 不弹窗直接切（前两次有效，第三次起仍会问你）' },
        mode: { type: 'string', enum: ['find', 'report'], description: 'library 用：find 查索引，report 提交更新' },
        query: { type: 'string', description: 'library find 的关键词（项目名 / 实验名 / 文件名）' },
        item: { type: 'string', description: 'library report 的材料名或路径' },
        change: { type: 'string', description: 'library report 的变更类型：新建 / 移动 / 改名 / 删除 / 内容大改 / 路径失效' },
        note: { type: 'string', description: 'library report 的一句话说明：这是什么、给谁用' },
        notes: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'clean 用：逐项补一句来源与用途，键为条目名（如 {"_pages":"实验报告 PDF 渲染页，用于逐页目检"}）',
        },
        markdown: { type: 'string', description: '整张卡的 markdown 内容（write 用）' },
        group: { type: 'string', description: 'manual 用：只看某一组' },
        verify: { type: 'string', description: 'use 用：本会话的验收命令，覆盖卡里的默认值' },
        verbose: { type: 'boolean', description: 'audit 用：连每层全文一起返回' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (args, value) => [{ type: 'text', text: String(value ?? '') }],
    },
    async execute(args, exec) {
      const action = args?.action
      try {
        if (action === 'use') return useAction(exec, args?.id, args?.verify)
        if (action === 'switch') return await switchAction(exec, args?.id, args?.auto === true)
        if (action === 'current') return currentAction(exec)
        if (action === 'release') return releaseAction(exec, args?.id)
        if (action === 'list') return listAction()
        if (action === 'show') return showAction(args?.id)
        if (action === 'manual') return manualAction(args?.group)
        if (action === 'reference') return referenceAction(exec, args?.id)
        if (action === 'write') return writeAction(args?.id, args?.markdown)
        if (action === 'audit') return await auditAction(args?.verbose === true)
        if (action === 'doctor') return doctorAction(exec)
        if (action === 'clean') return await cleanAction(exec, args?.path, args?.notes)
        if (action === 'library') {
          if (args?.mode === 'report') return libraryReport(exec, args?.item, args?.change, args?.note)
          return libraryFind(args?.query)
        }
        return `未知 action：${action}`
      } catch (error) {
        return `执行失败：${error?.message ?? error}`
      }
    },
  }

  let registered = 0
  try {
    const disposer = tools.register(definition)
    registered = 1
    if (typeof disposer === 'function' && typeof ctx.effect === 'function') {
      try {
        ctx.effect(() => disposer)
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* 工具注册失败不影响卡片注入 */
  }
  logLoad(dir, `done tools=${registered}`)
}
