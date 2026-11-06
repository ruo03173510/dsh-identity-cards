# 身份卡（dsh-identity-cards）

给 DSH 加一套「开工前先认卡」的机制：**一份卡片目录每轮注入，一个会话只认一张卡，换卡有迹可循。**

解决的问题：长期会话里规则越堆越多，模型抓不住重点；不同任务的规范互相打架；写了一半的文件不知道谁建的。

上限、下限、生态位与可拓展性，见 [WHY.md](WHY.md)。

## 在 DSH 的 Discover 里找到它

本仓库自带 `index.json`，可以直接当索引源：

```
Plugins → Discover → 管理索引源 → 添加
https://gitee.com/lunhuiruo/dsh-identity-cards/raw/main/index.json
```

加上之后就能在里面搜到「身份卡」。也可以跳过索引直接装：

```bash
dsh plugin add github:lunhuiruo/dsh-identity-cards   # 有 GitHub 镜像时
dsh plugin add file:<克隆下来的目录>
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
| 出问题了 | "身份卡工具好像没了，看看怎么回事" |

**唯一需要手动的一步是安装**（见下）。其余全部可以交给智能体。

## 它做什么

| 能力 | 一句话 |
|---|---|
| **卡片目录** | 每张卡一行（适用/不适用），每轮注入，占几十字 |
| **认卡** | 任务明确后自动认领，把那张卡的全文注入一次 |
| **互斥** | 一个会话只有一个身份，换卡必须声明 |
| **契约** | 一份跨卡的全局规则，可关 |
| **clean** | 扫出 `_` 开头的中间件，弹窗确认后删，逐项说明来源 |
| **library** | 资料索引：记路径、查路径、报更新；不扫盘就能找东西 |

## 安装

```bash
# 在 DSH 里
plugin_manager: install_bundle, target = <这个目录的绝对路径>
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

- 卡里的**样本路径是作者本机的**（`D:\pythoncode\...` 之类），照着换成你自己的
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
| `identity clean <dir>` | 扫中间件，确认后删，逐项说明来源 |
| `identity library mode=find query=…` | 查资料索引 |
| `identity library mode=report item=… change=…` | 提交一条材料更新 |

## 配置

```yaml
config:
  maxCards: 8        # 最多几张卡
  order: 40          # 提示里的顺序
  contract: false    # 关掉 7 条全局契约，只留卡片机制（默认 true）
  libraryDir: ...    # 资料索引目录，默认 $DSH_HOME/library
  libraryWarn: 50    # 更新表攒到多少条提醒合并
```

**`contract: false` 是给别人用的开关**：全局契约里有"不写装饰线""不写首先其次"这类个人偏好，用工具不一定接受这套写法。

## 已知限制

1. **注入不可撤销**：卡全文进了上下文就一直在，切换只能"宣布作废"，删不掉。这是 DSH 会话机制的硬约束。
2. **`file:` 依赖是复制不是链接**：改了源码要重装才生效。
3. **没有钩子**：卡的约束是提示词级别的，不像安全底线那样能拦截操作。
4. **只在 DSH 里能用**：依赖 Cordis 的 `systemPrompt` / `tools` / `userQuestions`。卡的内容本身是纯 markdown，别的 agent 可以直接当规范读。

## 自测

```bash
node selftest.mjs
```

不需要装 DSH，自带一个最小 harness。当前覆盖：卡解析、认卡、互斥、自动切卡上限、持久化、clean 确认、library 查询与提交、契约开关、空卡库降级。

## 目录

```
index.js            插件本体（一个文件，无依赖）
cordis.patch.yml    装配补丁
examples/           示例卡：minimal（最短）、writer（完整）
SCHEMA.md           卡的格式规范
selftest.mjs        自测
```

## License

MIT
