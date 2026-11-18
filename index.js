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
import { execFileSync } from 'node:child_process'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'

export const name = 'identity-cards'
export const inject = ['systemPrompt', 'tools']

const CACHE_TTL_MS = 1500
let cache = { key: '', at: 0, text: '' }

const VERSION = '1.3.0'

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

/** front-matter 里 res.<名字>: <引用> 的写法，扁平键是为了不动现有的行解析器。 */
function collectRefs(meta) {
  const out = {}
  for (const [key, value] of Object.entries(meta)) {
    if (!key.startsWith('res.')) continue
    const name = key.slice(4).trim()
    if (name) out[name] = parseRef(value)
  }
  return out
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
        handoff: splitList(meta.handoff),
        updatedAt: String(meta.updatedAt || '').trim(),
        resources: collectRefs(meta),
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
    `规程：会话默认是「默认卡」（未指定身份、零注入）。任务**明显**属于某张卡才认领——自动，只需告知用户；` +
      `**归不了类就不认领**，全局契约照常生效，别为了「有身份」硬认一张；` +
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
    '5. 中间文件必须可枚举：本次生成、只为产出结果服务的目录，一律用 `_tmp_<类>_名字` 命名，类别只这四个——`session` 会话依赖、`enginee` 可复用的工程文件、`transport` 转换工具与中间态、`record` 转换产物。`record` 是成果，清理时会用正向提问确认是否保留。交付物不带前缀。',
    '6. 改了东西就要有可复跑的验证证据（把改动退回后它应当失败）；纯讨论、判断、评审不写验证行。',
    '7. 新建或大修资源必须登记：调用 `identity` 的 `library` 动作，mode=report，一句话说明这是什么、放哪、给谁用。判据：**三个月后你还找得到吗？** 找东西先 `library` mode=find；已经在某个项目里就直接列目录，别查索引。',
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
  if (/^[a-z]:\\?$/i.test(resolved)) return `拒绝：${target} 是盘符根目录`
  return ''
}

/** 强力清理的额外护栏：不许扫到用户主目录、DSH_HOME 的上一级去（那样会一口吞掉整个家目录）。 */
function protectWide(resolved) {
  for (const base of [homedir(), process.env.DSH_HOME || join(homedir(), '.dsh')].map(item => resolve(item))) {
    const rel = relative(resolved, base)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
      return `拒绝：${resolved} 是 ${base} 的上一级目录，强力清理不往这里扫`
    }
  }
  return ''
}

/** 任何清理都不碰：版本库和依赖目录删掉就恢复不了。 */
const CLEAN_DENY = new Set(['.git', '.hg', '.svn', 'node_modules'])

/** 资源引用：<作用域>:<相对路径>[?tier=hot|cold][@sha256:xxxx] */
const RES_SCOPES = ['private', 'shared', 'project', 'global']

function parseRef(text) {
  const raw = String(text ?? '').trim()
  const tierAt = raw.match(/\?tier=(hot|cold)$/)
  const tier = tierAt ? tierAt[1] : 'cold'
  let rest = tierAt ? raw.slice(0, raw.length - tierAt[0].length) : raw
  const shaAt = rest.match(/@sha256:([0-9a-f]{8,64})$/i)
  const sha = shaAt ? shaAt[1].toLowerCase() : ''
  if (shaAt) rest = rest.slice(0, rest.length - shaAt[0].length)
  const colon = rest.indexOf(':')
  return {
    raw,
    scope: colon > 0 ? rest.slice(0, colon) : '',
    path: colon > 0 ? rest.slice(colon + 1) : rest,
    tier,
    sha,
  }
}

/** 项目登记表：@shared/projects.md。名字是唯一键，根变了只改这一处。 */
function readProjects(dir) {
  const file = join(dir, '@shared', 'projects.md')
  const map = new Map()
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { file, map }
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim())
    if (cells.length < 2) continue
    if (cells[0] === '名字' || /^[-:]+$/.test(cells[0])) continue
    map.set(cells[0], { root: cells[1], note: cells[2] || '' })
  }
  return { file, map }
}

const insideOf = (base, full) => {
  const b = resolve(base).toLowerCase()
  const f = resolve(full).toLowerCase()
  return f === b || f.startsWith(b.endsWith(sep) ? b : b + sep)
}

/** 解析一条引用。失败返回原因，不抛——卡加载不依赖资源是否还在。 */
function resolveResource(ref, cardId, env) {
  if (!RES_SCOPES.includes(ref.scope)) {
    return { ok: false, error: `缺作用域前缀（${RES_SCOPES.join(' / ')}）：${ref.raw}` }
  }
  const rel = String(ref.path || '').replace(/\\/g, '/').replace(/^\/+/, '')
  const parts = rel.split('/').filter(Boolean)
  if (!parts.length || parts.some(part => part === '..' || part === '.')) {
    return { ok: false, error: `路径不合法：${ref.raw}` }
  }
  let base
  let tail = parts
  if (ref.scope === 'project') {
    const entry = env.projects.map.get(parts[0])
    if (!entry) return { ok: false, error: `没有登记项目 ${parts[0]}（见 ${env.projects.file}）` }
    base = entry.root
    tail = parts.slice(1)
    if (!tail.length) return { ok: false, error: `项目引用缺文件路径：${ref.raw}` }
  } else if (ref.scope === 'private') {
    base = env.privateDir
  } else {
    base = env.roots[ref.scope]
  }
  const full = join(base, ...tail)
  if (!insideOf(base, full)) return { ok: false, error: `引用越界：${ref.raw}` }
  let stat
  try {
    stat = statSync(full)
  } catch {
    return { ok: false, full, error: `文件不存在：${full}` }
  }
  return {
    ok: true,
    full,
    base,
    dir: stat.isDirectory(),
    size: stat.isDirectory() ? 0 : stat.size,
    mtime: stat.mtime.toISOString(),
  }
}

function shortHash(file) {
  try {
    const stat = statSync(file)
    if (!stat.isFile() || stat.size > 1048576) return ''
    return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 8)
  } catch {
    return ''
  }
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
    for (const [key, value] of Object.entries(meta)) {
      if (!key.startsWith('res.')) continue
      if (!RES_SCOPES.includes(parseRef(value).scope)) {
        problems.push(`资源 ${key} 缺作用域前缀（${RES_SCOPES.join(' / ')}）`)
      }
    }
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

  const registeredNames = []

  // 装配时按卡/全局 allowlist 裁剪工具 schema。都没配就只记数、原样返回
  const KEEP_ALWAYS = new Set(['identity', 'skill', 'tool_admin'])
  const runtimeGranted = new Set()
  // 持久白名单存一个小 JSON，跨重启保留
  const grantsFile = join(homedir(), '.dsh', 'tool-grants.json')
  const loadGrants = () => {
    try {
      const j = JSON.parse(readFileSync(grantsFile, 'utf8'))
      return Array.isArray(j?.always) ? j.always.filter((n) => typeof n === 'string') : []
    } catch {
      return []
    }
  }
  const saveGrants = (list) => {
    try {
      writeFileSync(grantsFile, JSON.stringify({ always: list }, null, 2), 'utf8')
    } catch {
      /* 写不进去只影响持久化，内存里仍然生效 */
    }
  }
  const persistentGranted = new Set(loadGrants())
  let lastAllTools = []
  let assembleProbes = 0
  if (typeof ctx.on === 'function') {
    try {
      ctx.on('system-prompt/assemble', async (...args) => {
        const [assembly, context, next] = args
        const base = typeof next === 'function' ? await next() : assembly
        const tools = Array.isArray(base?.tools) ? base.tools : null
        if (!tools) return base
        lastAllTools = tools.map((t) => t?.name).filter(Boolean)

        // scope 可能是 agent 本身，也可能是 scope key；两种都试
        const scopeId = context?.scope?.id ?? context?.scope ?? context?.agent?.id ?? null
        const cardId = scopeId === null ? null : (claims.get(String(scopeId))?.id ?? null)
        const byCard = config?.toolAllowlistByCard && typeof config.toolAllowlistByCard === 'object' ? config.toolAllowlistByCard : null
        const cardList = cardId && byCard && Array.isArray(byCard[cardId]) ? byCard[cardId] : null
        const globalList = Array.isArray(config?.toolAllowlist) && config.toolAllowlist.length ? config.toolAllowlist : null
        const list = cardList ?? globalList

        assembleProbes += 1
        if (!list) {
          if (assembleProbes <= 1) logLoad(dir, `assemble tools=${tools.length} scope=${scopeId} card=${cardId}（无白名单，不过滤）`)
          return base
        }
        const allow = new Set([...list, ...KEEP_ALWAYS, ...runtimeGranted, ...persistentGranted])
        const filtered = tools.filter((t) => allow.has(t?.name))
        if (assembleProbes <= 3) logLoad(dir, `assemble#${assembleProbes} tools ${tools.length} -> ${filtered.length} scope=${scopeId} card=${cardId} granted=${runtimeGranted.size}`)
        return { ...base, tools: filtered }
      })
    } catch (e) {
      logLoad(dir, `assemble-listener fail ${e?.message ?? e}`)
    }
  }

  const listAction = () => {
    const cards = collect(dir, max)
    if (!cards.length) return `卡库为空：${dir}`
    const rows = cards.map(card => {
      // 只看样本节：卡正文里教「检查占位符」不算自己有空位。
      const sample = (card.raw.split(/^##\s*5\.[^\n]*$/m)[1] || '')
      const filled = /待填/.test(sample) ? '（有未填占位）' : ''
      const state = Object.keys(card.resources).length ? resourceState(card) : null
      const resLine = state ? `\n  ↳ ${state.total} 个引用，${state.ok} 个可解析` : ''
      return `${card.id}｜${card.name}｜v${card.version || '?'}｜适用：${joinOrDash(card.trigger)}｜不适用：${joinOrDash(card.expire)}${filled}\n  ${card.path}${resLine}`
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
    (effective ? `验收命令：${effective}（收尾前必须跑，命中即失败）` : '验收：本卡没有验收命令，判据只能靠自觉。') +
    (card.handoff.length
      ? `\n\n交接：这次任务收尾后如果要独立审查，用 identity switch ${card.handoff.join(' / ')}（会先问你）；把本次产物路径一并带过去，别让它重读你的思路。`
      : '')

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

  // vault 后端：config.vaultCli → ~/.dsh/identity.json 的 vaultCli → 都没有就退回 markdown
  const vaultCli = () => {
    if (process.env.DSH_IDENTITY_NO_VAULT === '1') return ''
    const fromConfig = typeof config?.vaultCli === 'string' ? config.vaultCli : ''
    if (fromConfig) return fromConfig
    try {
      const j = JSON.parse(readFileSync(join(homedir(), '.dsh', 'identity.json'), 'utf8'))
      if (typeof j?.vaultCli === 'string' && j.vaultCli) return j.vaultCli
    } catch {
      /* 没配文件就退回 markdown 索引 */
    }
    return ''
  }

  const vaultRows = query => {
    const cli = vaultCli()
    if (!cli) return null
    try {
      // ELECTRON_RUN_AS_NODE：在桌面版里用同一个内置 Node 跑，不依赖 PATH
      const out = execFileSync(process.execPath, [cli, 'find', String(query || ''), '--json', '--limit', '8'], {
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      })
      const rows = JSON.parse(out)
      return Array.isArray(rows) ? rows : null
    } catch {
      return null
    }
  }

  const libraryFind = query => {
    const vrows = vaultRows(query)
    if (vrows) {
      if (!vrows.length) return `vault 里没有匹配「${query}」。`
      const lines = vrows.map(r => {
        const kb = Math.max(1, Math.round(r.size / 1024))
        const day = new Date(r.mtime).toISOString().slice(0, 10)
        const sum = r.summary ? `\n    摘要：${r.summary}` : ''
        return `- ${r.id}｜${r.rel_path}｜${kb} KB｜${day}${sum}`
      })
      return `vault 命中 ${vrows.length} 条：\n${lines.join('\n')}\n用 vault show <id> 看正文。`
    }
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

  /** 全局资源根。卡只存引用，这里才是「去哪找」的最后一跳。 */
  const resourcesRoot =
    typeof config?.resourcesDir === 'string' && config.resourcesDir
      ? resolve(config.resourcesDir)
      : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'resources')

  const envFor = cardId => ({
    privateDir: join(dir, cardId),
    roots: { shared: join(dir, '@shared'), global: resourcesRoot },
    projects: readProjects(dir),
  })

  const indexFile = () => join(dir, '@shared', 'resources', 'index.md')

  const resourceState = card => {
    const env = envFor(card.id)
    const names = Object.keys(card.resources)
    const ok = names.filter(name => resolveResource(card.resources[name], card.id, env).ok).length
    return { total: names.length, ok }
  }

  const resolveAction = (id, name) => {
    if (!id) return '需要 id 参数：哪张卡'
    if (!name) return '需要 name 参数：资源名（卡里 res.<名字> 的那一段）'
    const card = collect(dir, max).find(item => item.id === id)
    if (!card) return `没有这张卡：${id}`
    const names = Object.keys(card.resources)
    if (!names.length) return `${id} 没有声明资源。写法：front-matter 里 res.format: shared:templates/x.md`
    const ref = card.resources[name]
    if (!ref) return `${id} 没有资源 ${name}。现有：${names.join('、')}`
    const result = resolveResource(ref, id, envFor(id))
    if (!result.ok) return `解析失败：${result.error}`
    return [
      `${id} / ${name}`,
      `  引用：${ref.raw}（tier=${ref.tier}）`,
      `  路径：${result.full}${result.dir ? '（目录）' : ''}`,
      `  ${result.dir ? '目录' : `大小 ${formatSize(result.size)}`}｜mtime ${result.mtime}`,
    ].join('\n')
  }

  const resourcesAction = (exec, mode, onlyId) => {
    if (mode === 'status') {
      let text = ''
      try {
        text = readFileSync(indexFile(), 'utf8')
      } catch {
        return `还没有索引表：${indexFile()}\n先跑 identity resources mode=scan`
      }
      const rows = text.split(/\r?\n/).filter(line => {
        const trimmed = line.trim()
        return trimmed.startsWith('|') && !/^\|\s*卡/.test(trimmed) && !/^\|[-:\s|]+$/.test(trimmed)
      })
      const broken = rows.filter(line => line.includes('断链')).length
      const changed = rows.filter(line => line.includes('内容变')).length
      return `索引 ${rows.length} 条｜正常 ${rows.length - broken - changed}｜断链 ${broken}｜内容变 ${changed}\n表：${indexFile()}`
    }
    const cards = onlyId ? collect(dir, max).filter(card => card.id === onlyId) : collect(dir, max)
    if (!cards.length) return onlyId ? `没有这张卡：${onlyId}` : `卡库为空：${dir}`
    const lines = ['| 卡 | 资源 | 引用 | 路径 | 大小 | mtime | sha8 | 状态 |', '|---|---|---|---|---|---|---|---|']
    const drift = []
    let ok = 0
    let broken = 0
    for (const card of cards) {
      const env = envFor(card.id)
      for (const [name, ref] of Object.entries(card.resources)) {
        const result = resolveResource(ref, card.id, env)
        if (!result.ok) {
          broken += 1
          drift.push(`${card.id}/${name}：${result.error}`)
          lines.push(`| ${card.id} | ${name} | ${ref.raw} | — | — | — | — | 断链 |`)
          continue
        }
        ok += 1
        const hash = result.dir ? '' : shortHash(result.full)
        const changed = Boolean(ref.sha && hash && hash !== ref.sha)
        if (changed) drift.push(`${card.id}/${name}：内容变了（记 ${ref.sha}，现 ${hash}）`)
        lines.push(
          `| ${card.id} | ${name} | ${ref.raw} | ${result.full} | ${formatSize(result.size)} | ${result.mtime} | ${hash || '—'} | ${changed ? '内容变' : '正常'} |`,
        )
      }
    }
    try {
      mkdirSync(join(dir, '@shared', 'resources'), { recursive: true })
      writeFileSync(indexFile(), `${lines.join('\n')}\n`, 'utf8')
    } catch (error) {
      return `写索引失败：${error?.message ?? error}`
    }
    for (const item of drift) {
      const at = item.indexOf('：')
      libraryReport(exec, at > 0 ? item.slice(0, at) : item, '引用漂移', item)
    }
    const tail = drift.length ? `\n漂移 ${drift.length} 条，已写进更新表：\n- ${drift.join('\n- ')}` : ''
    return `扫了 ${cards.length} 张卡：引用 ${ok + broken} 条，正常 ${ok}，断链 ${broken}。\n索引：${indexFile()}${tail}`
  }

  /** 读目录条目并统计体积，clean 用。 */
  const scanEntries = resolved =>
    readdirSync(resolved, { withFileTypes: true }).map(entry => {
      const full = join(resolved, entry.name)
      const { total, files } = dirSize(full)
      return { name: entry.name, full, dir: entry.isDirectory(), files, total }
    })

  /** 列清单、弹确认、删。两个清理工具共用，区别只在 hits 怎么来的。 */
  const removeWithConfirm = async (exec, plan) => {
    const { askId, header, title, question, deleteLabel, hits, extra = [] } = plan
    const sum = hits.reduce((acc, hit) => acc + hit.total, 0)
    const list = hits.map(hit => {
      const where = `${hit.full}${hit.dir ? '\\' : ''}（${hit.files} 文件，${formatSize(hit.total)}）`
      return `${where}\n    来源与用途：${hit.note}`
    })
    const lines = [title]
    if (hits.length) lines.push(`- ${list.join('\n- ')}`, `合计 ${hits.length} 项，${formatSize(sum)}`)
    else lines.push('没有条目被列入删除清单。')
    lines.push(...extra)
    const preview = lines.join('\n')
    if (!hits.length) return `${preview}\n\n未删除：清单是空的。`

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
            id: askId,
            header,
            question,
            detail: list.join('\n'),
            options: [
              { label: deleteLabel, description: '删掉上面列出的条目，不可恢复' },
              { label: '取消', description: '什么都不删' },
            ],
          },
        ],
      })
    } catch (error) {
      return `${preview}\n\n未删除：确认弹窗失败——${error?.message ?? error}`
    }
    const selected = answer?.answers?.[0]?.selected ?? []
    if (!selected.includes(deleteLabel)) return `${preview}\n\n你选择了取消，未删除。`

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

  const CLEAN_TMP_RE = /^_tmp_(session|enginee|transport|record)_(.+)$/

  /**
   * 四档清理：
   * tmp（默认）按 _tmp_<类>_ 分组，session/transport 问删，enginee 只列，record 正向问保留；
   * name 点名删除，范围由 scope 指定或推测；
   * list 指定清单，无视命名；
   * force 强删单个条目，失败只报告占用，不自动杀进程。
   */
  const cleanAction = async (exec, options = {}) => {
    const { path: target, notes = {}, mode = 'tmp', item = '', items = [], scope = '' } = options
    const base = resolve(scope || target || process.cwd())
    const guard = protectPath(base)
    if (guard) return guard
    let all
    try {
      all = scanEntries(base)
    } catch (error) {
      return `读不了目录：${error?.message ?? error}`
    }
    const wanted = [...new Set((Array.isArray(items) ? items : []).map((x) => String(x).trim()).filter(Boolean))]
    const findOne = (name) => all.find((entry) => entry.name === name)
    const noteOf = (entry) => notes[entry.name] || describeName(entry.name) || '来源未标注'

    if (mode === 'force') {
      const name = String(item || '').trim()
      if (!name) return 'force 模式需要 item 参数：要强删的单个条目名'
      const entry = findOne(name)
      if (!entry) return `${base} 下没找到 ${name}`
      if (CLEAN_DENY.has(entry.name)) return `${name} 属于版本库或依赖目录，拒绝`
      try {
        rmSync(entry.full, { recursive: true, force: true })
        return `已强删 ${entry.full}`
      } catch (error) {
        return `删除失败：${error?.message ?? error}\n可能是进程占用。这里不自动杀进程，请手动关闭相关程序后重试。`
      }
    }

    if (mode === 'list' || mode === 'name') {
      const names = wanted.length ? wanted : item ? [String(item).trim()] : []
      if (!names.length) return `${mode} 模式需要 item 或 items 参数`
      const byName = new Map(all.map((entry) => [entry.name, entry]))
      const hits = []
      const missing = []
      for (const name of names) {
        const entry = byName.get(name)
        if (entry && !CLEAN_DENY.has(entry.name)) hits.push({ ...entry, note: noteOf(entry) })
        else missing.push(name)
      }
      const extra = missing.length ? [`找不到或受保护：${missing.join('、')}`] : []
      return removeWithConfirm(exec, {
        askId: `clean-${mode}`,
        header: '指定清理',
        title: `${base} 下点名 ${names.length} 个条目：`,
        question: `确认删除 ${hits.length} 项？共 ${formatSize(hits.reduce((acc, hit) => acc + hit.total, 0))}，不可恢复`,
        deleteLabel: '删除',
        hits,
        extra,
      })
    }

    const groups = { session: [], enginee: [], transport: [], record: [] }
    const unmarked = []
    for (const entry of all) {
      const m = CLEAN_TMP_RE.exec(entry.name)
      if (m) groups[m[1]].push({ ...entry, note: noteOf(entry) })
      else if (entry.name.startsWith('_')) unmarked.push(entry.name)
    }
    const out = []
    for (const key of ['session', 'transport']) {
      if (!groups[key].length) continue
      const sum = groups[key].reduce((acc, hit) => acc + hit.total, 0)
      out.push(await removeWithConfirm(exec, {
        askId: `clean-${key}`,
        header: `清理 ${key}`,
        title: `${base} 下的 _tmp_${key}_ 条目：`,
        question: `确认删除这 ${groups[key].length} 项？共 ${formatSize(sum)}，不可恢复`,
        deleteLabel: '确认删除',
        hits: groups[key],
      }))
    }
    if (groups.enginee.length) {
      const sum = groups.enginee.reduce((acc, hit) => acc + hit.total, 0)
      out.push([
        `_tmp_enginee_ ${groups.enginee.length} 项，${formatSize(sum)}——工程文件，默认不删。`,
        ...groups.enginee.map((hit) => `- ${hit.name}`),
        '要删请用 mode=name 点名。',
      ].join('\n'))
    }
    if (groups.record.length) {
      const sum = groups.record.reduce((acc, hit) => acc + hit.total, 0)
      out.push(await removeWithConfirm(exec, {
        askId: 'clean-record',
        header: '清理 record',
        title: `${base} 下的 _tmp_record_ 条目：`,
        question: `这些是任务产出，确定不作为知识资产保留吗？确认后会删除这 ${groups.record.length} 项（${formatSize(sum)}）`,
        deleteLabel: '不保留，删除',
        hits: groups.record,
      }))
    }
    if (unmarked.length) {
      out.push(`另有 ${unmarked.length} 个 \`_\` 开头的未标注条目（旧格式），不参与分类清理：${unmarked.slice(0, 10).join('、')}${unmarked.length > 10 ? ' …' : ''}`)
    }
    return out.length ? out.join('\n\n') : `${base}：没有 \`_tmp_<类>_\` 条目。`
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
      `工具：${registeredNames.length ? registeredNames.join(' / ') : '未注册'}`,
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
      '身份卡通用命令：会话默认是「默认卡」（未指定身份）。use 从默认卡认领一张卡（自动，只告知，全文注入一次）；switch 从一张具体卡换到另一张（auto=true 可不问，前两次有效，第三次起仍会问你；切换后旧卡判据即刻作废，回复第一行须写「已切至身份卡：<id>」）；current 看当前生效的卡；release 不允许（回不到默认卡）；manual 分级表；list 列卡；show 看卡全文；reference 带标注参考另一张卡；write 新增或修改卡；audit 审计提示层；doctor 自检；clean 四档清理：tmp 按 `_tmp_<类>_` 分组（session/transport 问删、enginee 只列、record 正向问保留）、name 点名、list 指定清单、force 强删单个且失败只报占用；library 资料索引——mode=find 按关键词查路径（带未确认天数），mode=report 提交一条材料更新（新建/大修后必须报）；resolve 看某条资源解析到哪（id + name，四个作用域 private/shared/project/global）；resources mode=scan 扫引用、重建索引并把漂移写进更新表，mode=status 看汇总。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['use', 'switch', 'current', 'release', 'list', 'show', 'manual', 'reference', 'write', 'audit', 'doctor', 'clean', 'library', 'resolve', 'resources'],
        },
        id: { type: 'string', description: '卡 id（use / show / write / release 用）' },
        path: { type: 'string', description: 'clean 用：要扫描中间件的目录' },
        auto: { type: 'boolean', description: 'switch 用：true = 不弹窗直接切（前两次有效，第三次起仍会问你）' },
        mode: { type: 'string', enum: ['find', 'report', 'scan', 'status'], description: 'library 用 find / report；resources 用 scan / status' },
        name: { type: 'string', description: 'resolve 用：资源名（front-matter 里 res.<名字> 的那一段）' },
        query: { type: 'string', description: 'library find 的关键词（项目名 / 实验名 / 文件名）' },
        item: { type: 'string', description: 'library report 的材料名或路径' },
        change: { type: 'string', description: 'library report 的变更类型：新建 / 移动 / 改名 / 删除 / 内容大改 / 路径失效' },
        note: { type: 'string', description: 'library report 的一句话说明：这是什么、给谁用' },
        notes: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'clean 用：逐项补一句来源与用途，键为条目名（如 {"_pages":"实验报告 PDF 渲染页，用于逐页目检"}）',
        },
        mode: {
          type: 'string',
          enum: ['tmp', 'name', 'list', 'force'],
          description: 'clean 用：tmp 按 _tmp_<类>_ 分组清理（默认，session/transport 问删、enginee 只列、record 正向问保留）；name 点名一个；list 指定清单；force 强删单个且失败只报占用',
        },
        item: { type: 'string', description: 'clean 用：name / force 模式下的条目名' },
        items: { type: 'array', items: { type: 'string' }, description: 'clean 用：list 模式的条目清单' },
        scope: { type: 'string', description: 'clean 用：条目所在目录，默认用 path 或当前目录' },
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
        if (action === 'clean') {
          return await cleanAction(exec, {
            path: args?.path,
            notes: args?.notes,
            mode: args?.mode,
            item: args?.item,
            items: args?.items,
            scope: args?.scope,
          })
        }
        if (action === 'library') {
          if (args?.mode === 'report') return libraryReport(exec, args?.item, args?.change, args?.note)
          return libraryFind(args?.query)
        }
        if (action === 'resolve') return resolveAction(args?.id, args?.name)
        if (action === 'resources') return resourcesAction(exec, args?.mode === 'status' ? 'status' : 'scan', args?.id)
        return `未知 action：${action}`
      } catch (error) {
        return `执行失败：${error?.message ?? error}`
      }
    },
  }

  const toolAdminDefinition = {
    name: 'tool_admin',
    description:
      '工具白名单的查看与增补。action=list 列出全部工具，标出可见、被裁、持久、临时；action=enable 临时加回（本会话有效，重启失效）；action=always 持久加回（写入 ~/.dsh/tool-grants.json，跨重启有效）；action=forget 从持久和临时里一起移除。身份卡缺少某个工具时，先告诉用户缺哪个、是要临时还是持久，用户同意后再执行，不要自己决定。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'enable', 'always', 'forget'], description: 'list 查看；enable 临时加回；always 持久加回；forget 移除' },
        name: { type: 'string', description: 'enable / always / forget 用：工具名' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (args, value) => [{ type: 'text', text: String(value ?? '') }],
    },
    async execute(args) {
      const action = args?.action
      if (action === 'enable' || action === 'always') {
        const name = String(args?.name ?? '').trim()
        if (!name) return '需要 name 参数'
        if (!lastAllTools.includes(name)) return `没有这个工具：${name}`
        if (action === 'enable') {
          runtimeGranted.add(name)
          return `已临时加回 ${name}，本会话有效，重启后失效。`
        }
        persistentGranted.add(name)
        saveGrants([...persistentGranted])
        return `已持久加回 ${name}，写入 ${grantsFile}，跨重启有效。`
      }
      if (action === 'forget') {
        const name = String(args?.name ?? '').trim()
        if (!name) return '需要 name 参数'
        runtimeGranted.delete(name)
        const had = persistentGranted.delete(name)
        saveGrants([...persistentGranted])
        return had ? `已从持久白名单移除 ${name}` : `持久白名单里没有 ${name}（临时加回也已清除）`
      }
      const base = [...(Array.isArray(config?.toolAllowlist) ? config.toolAllowlist : []), ...KEEP_ALWAYS, ...runtimeGranted, ...persistentGranted]
      const allowed = new Set(base)
      const visible = lastAllTools.filter((n) => allowed.has(n))
      const hidden = lastAllTools.filter((n) => !allowed.has(n))
      return [
        `全部 ${lastAllTools.length} 个工具`,
        `可见 ${visible.length}：${visible.join(', ') || '（无）'}`,
        `持久 ${persistentGranted.size}：${[...persistentGranted].join(', ') || '（无）'}`,
        `临时 ${runtimeGranted.size}：${[...runtimeGranted].join(', ') || '（无）'}`,
        `被裁 ${hidden.length}：${hidden.join(', ') || '（无）'}`,
        hidden.length ? `临时加回：tool_admin action=enable name=<工具名>` : '',
        hidden.length ? `持久加回：tool_admin action=always name=<工具名>` : '',
      ].filter(Boolean).join('\n')
    },
  }

  let registered = 0
  for (const def of [definition, toolAdminDefinition]) {
    try {
      const disposer = tools.register(def)
      registered += 1
      registeredNames.push(def.name)
      if (typeof disposer === 'function' && typeof ctx.effect === 'function') {
        try {
          ctx.effect(() => disposer)
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* 单个工具注册失败不影响另一个 */
    }
  }
  logLoad(dir, `done tools=${registered}`)
}
