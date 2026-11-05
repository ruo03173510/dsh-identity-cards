# 身份卡（dsh-identity-cards）

给 DSH 加一套「开工前先认卡」的机制：**一份卡片目录每轮注入，一个会话只认一张卡，换卡有迹可循。**

解决的问题：长期会话里规则越堆越多，模型抓不住重点；不同任务的规范互相打架；写了一半的文件不知道谁建的。

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

```bash
# 1. 建卡：把示例拷进卡库（目录名就是卡 id）
cp -r examples/minimal ~/.dsh/cards/my-card

# 2. 改这张卡
~/.dsh/cards/my-card/card.md

# 3. 看效果
identity list
```

卡库默认在 `~/.dsh/cards`，用 `config.cardsDir` 可以改。

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
