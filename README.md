# 身份卡（dsh-identity-cards）

**把 AI 的行为装进卡：提示词、资源、工具都与会话解耦，按任务加载。**

长期用 DSH 的人会撞到同一堵墙：规则越堆越多，不同任务的规范互相打架，工具 schema 越装越大，资料散在各个盘里找不到。身份卡把这三样东西从会话里搬出来，改成「按任务装载」。

装一次，长期用。规则写进卡，资料交给检索，工具按卡开关。

## 三个层次

| 层 | 解决什么 | 怎么做到 |
|---|---|---|
| **面向任务** | 提示词和资源跟会话解耦 | 卡只存「引用 + 加载时机」，内容按需取；卡全文认领时注入一次，其余资源用到才读 |
| **丰富工具** | 长期多项目开发 | 工具白名单 + 按需加回；中间文件按 `_tmp_<类>_` 命名；检索走本地索引而不是扫盘 |
| **身份卡** | 个性化自定义 | 会话与资源、提示词解耦的进一步：一个会话一个身份，换卡即换规矩，旧卡判据即刻作废 |

设计取舍与边界见 [WHY.md](WHY.md)，完整架构见 [docs/架构总纲.md](docs/架构总纲.md)。

## 在 DSH 的 Discover 里找到它

本仓库自带 `index.json`，可以直接当索引源：

```
Plugins → Discover → 管理索引源 → 添加
https://github.com/ruo03173510/dsh-identity-cards/raw/main/index.json
```

加上之后就能在里面搜到「身份卡」。也可以跳过索引直接装：

```bash
dsh plugin add dsh-identity-cards          # 从 npm
dsh plugin add file:<克隆下来的目录>        # 从源码
```

## 你不需要记命令，说这几句话就行

装完之后，所有操作都可以用自然语言让智能体做：

| 你想要 | 说 |
|---|---|
| 建一张卡 | "帮我建一张写周报的卡：要点式、不要客套话" |
| 改卡 | "实验报告那张卡，加一条'图表必须编号'" |
| 看有什么卡 | "我现在有哪些身份卡" |
| 换任务 | 什么都不用说——它会自己切，切完第一行会告诉你 |
| 找文件 | "上次那个图形学的对比包放哪了" |
| 清临时文件 | "把桌面上的中间文件清一下" |
| 工具不够用 | "我需要用一下 XX 工具"——它会先问你，再加回 |
| 出问题了 | "身份卡工具好像没了，看看怎么回事" |

**唯一需要手动的一步是安装**。其余全部可以交给智能体。

## 它做什么

| 能力 | 一句话 |
|---|---|
| **卡片目录** | 每张卡一行（适用/不适用），每轮注入，占几十字 |
| **认卡** | 任务明确后自动认领，把那张卡的全文注入一次 |
| **互斥** | 一个会话只有一个身份，换卡必须声明 |
| **契约** | 一份跨卡的全局规则，可关 |
| **clean** | 四档清理：`tmp` 按 `_tmp_<类>_` 分组（session/transport 问删、enginee 只列、record 正向问保留）、`name` 点名、`list` 指定清单、`force` 强删单个 |
| **library** | 资料索引：记路径、查路径、报更新；不扫盘就能找东西 |
| **tool_admin** | 工具白名单的查看与增补：`list` 看全量、`enable` 临时加回、`always` 持久加回、`forget` 移除 |
| **工具裁剪** | 装配时按卡裁剪工具 schema，不需要的工具不发给模型，减少每轮开销 |

## 安装

```bash
# 从 npm
dsh plugin add dsh-identity-cards

# 或从源码
git clone https://github.com/ruo03173510/dsh-identity-cards.git
# 在 DSH 里：
plugin_manager: install_bundle, target = <仓库的绝对路径>
```

装完重启 DSH，`identity` 工具就出现在工具列表里。

**如果重启后 `identity` 不见了**：说明插件没加载上，`remove_bundle` 再 `install_bundle` 一次。

## 第一次使用

你可以直接说"帮我建一张卡"，它会给一份骨架（`identity write id=<卡名>`），你只需要填 `trigger` / `expire` 和正文四节。
也可以把示例拷进卡库（目录名就是卡 id）：

```bash
cp -r examples/minimal ~/.dsh/cards/my-card
```

卡库默认在 `~/.dsh/cards`，用 `config.cardsDir` 可以改。

## 现成的卡（可选，默认不装）

仓库里带了 5 张作者自用的卡，放在 `examples/cards/`。**装上插件不会自动启用它们**——卡片只有被放进卡库目录才会被读到。

| 卡 | 管什么 |
|---|---|
| `lab-report` | 实验报告、课程设计、论文、docx 排版 |
| `code` | 写代码、改代码、调试、重构 |
| `meta` | 方案讨论、需求梳理、定规则 |
| `review` | 独立审查：只审不改，结论分三档 |
| `ops` | 运维助手：台账、备份、定时任务、环境维护 |

想用哪张就拷哪张：

```bash
cp -r examples/cards/code ~/.dsh/cards/code
```

两点说明：

- 卡里的**样本路径是作者本机的**，照着换成你自己的
- `ops` 卡会引用 `~/.dsh/cards/ops/notes.md` 台账和 `ledger/`、`backup/` 两个目录，第一次用先建个空的

## 命令

| 命令 | 做什么 |
|---|---|
| `identity list` | 列出所有卡 |
| `identity use <id>` | 从默认卡认领一张（自动，只告知） |
| `identity switch <id> [auto]` | 换卡；auto 可不问，一个会话最多两次 |
| `identity current` | 当前身份 |
| `identity show <id>` | 看卡全文（只看，不换身份） |
| `identity reference <id>` | 带标注参考另一张卡（不改身份） |
| `identity audit` | 每张卡占多少字符、全局提示多大 |
| `identity doctor` | 自检：版本、卡解析、当前身份、加载记录 |
| `identity clean <dir>` | 四档清理，见上表；默认只认 `_tmp_<类>_` |
| `identity library mode=find query=…` | 查资料索引 |
| `identity library mode=report item=… change=…` | 提交一条材料更新 |
| `identity resolve id=… name=…` | 看某条资源引用解析到哪个路径 |
| `identity resources mode=scan` | 扫引用、重建索引，漂移写进更新表 |
| `identity resources mode=status` | 看索引条数、断链、内容变 |
| `tool_admin action=list` | 看全部工具，分可见 / 持久 / 临时 / 被裁 |
| `tool_admin action=enable name=…` | 临时加回一个被裁的工具 |
| `tool_admin action=always name=…` | 持久加回，写入 `~/.dsh/tool-grants.json` |

## 中间文件命名

生成的中间文件用 `_tmp_<类>_名字`，类别四个：

| 前缀 | 含义 | 清理时 |
|---|---|---|
| `_tmp_session_` | 会话依赖文件 | 问「确定删除」 |
| `_tmp_enginee_` | 可复用的工程文件 | 只列不删 |
| `_tmp_transport_` | 转换工具与中间态 | 问「确定删除」 |
| `_tmp_record_` | 转换产物，成果 | 正向问「确定不作为知识资产保留」 |

交付物不带前缀。旧式 `_` 前缀不再当中间件，`clean` 只提示「另有 N 个未标注条目」。

## 资源引用

卡只存引用，样本、模板、规则源放别处，四个作用域：`private`（卡内）、`shared`（`@shared/`）、`project`（`@shared/projects.md` 登记的项目根）、`global`（`$DSH_HOME/resources/`）。

```yaml
res.format: shared:templates/report-format.md
res.sample: private:samples/regression.py?tier=hot
res.rules: project:course-graph/reports/rules/report.rules.json
```

加载卡只读 `card.md`，不碰资源；引用在 `list` / `resolve` / `scan` 时才 stat。断链不阻断加载，只把「N 个引用，M 个可解析」写进 `list`。详见 [SCHEMA.md](SCHEMA.md)。

## 检索后端（可选）

`vault/` 是一个独立的本地文件索引：注册时只读元数据，检索走 SQLite，带摘要，支持增量。它让 `library find` 从「读 markdown 表」变成「查数据库」。

```bash
cd vault
node src/cli.mjs root add desktop "C:\Users\你\Desktop"
node src/cli.mjs register "C:\Users\你\Desktop"
node src/cli.mjs find 实验五 --limit 5
```

然后在 `~/.dsh/identity.json` 里写：

```json
{ "vaultCli": "C:/路径/vault/src/cli.mjs" }
```

没配也能用——`library find` 会退回原来的 markdown 索引，不会报错。

## 配置

```yaml
config:
  maxCards: 8        # 最多几张卡
  order: 40          # 提示里的顺序
  contract: false    # 关掉全局契约，只留卡片机制（默认 true）
  libraryDir: ...    # 资料索引目录，默认 $DSH_HOME/library
  libraryWarn: 50    # 更新表攒到多少条提醒合并
  resourcesDir: ...  # global 资源根，默认 $DSH_HOME/resources
  vaultCli: ...      # 可选：vault 的 src/cli.mjs 绝对路径（也可写在 ~/.dsh/identity.json）
  toolAllowlist: []  # 可选：工具白名单，没配就不过滤
  toolAllowlistByCard:
    code: []         # 按卡覆盖，优先于 toolAllowlist
```

**`contract: false` 是给别人用的开关**：全局契约里有"不写装饰线""不写首先其次"这类个人偏好，用工具不一定接受这套写法。

## 已知限制

1. **注入不可撤销**：卡全文进了上下文就一直在，切换只能"宣布作废"，删不掉。这是 DSH 会话机制的硬约束。
2. **工具绑定按会话**：`tool_admin` 的临时加回只在本会话有效；持久加回写文件，下次启动读。
3. **没有钩子**：卡的约束是提示词级别的，不像安全底线那样能拦截操作。`clean` 的「删除前确认」是唯一硬闸。
4. **只在 DSH 里能用**：依赖 Cordis 的 `systemPrompt` / `tools` / `userQuestions`。卡的内容本身是纯 markdown，别的 agent 可以直接当规范读。

## 自测

```bash
node selftest.mjs
```

不需要装 DSH，自带一个最小 harness。当前覆盖：卡解析、认卡、互斥、自动切卡上限、持久化、clean 四档（分组 / 点名 / 清单 / 强删）与确认闸、library 查询与提交、tool_admin、契约开关、空卡库降级。

`vault/` 有独立自测：

```bash
cd vault && node test/selftest.mjs
```

## 目录

```
index.js            插件本体（一个文件，无依赖）
cordis.patch.yml    装配补丁
examples/           示例卡：minimal（最短）、writer（完整）、cards/（五张自用卡）
SCHEMA.md           卡的格式规范
selftest.mjs        自测
docs/               架构总纲、进度、实验结论
vault/              检索后端（独立包，可选）
```

## License

Apache-2.0
