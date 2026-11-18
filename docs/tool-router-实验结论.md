# dsh-tool-router 实验结论（已归档）

> 2026-11-18 归档。包装插件方案已放弃，被 `system-prompt/assemble` 过滤方案取代。这里保留结论，避免以后重走。

**能捕获，省不了体积。当前净省 351 字节，不再扩大。**

## 实测数字

| 项目 | 字节 |
|---|---|
| 会话可见 64 个工具的 schema 合计 | 56,888 |
| `webrelay_captures` | 689 |
| `tool_router` | 338 |
| 净变化 | −351 |
| `dsh-bili-scroll` 的 20 个工具 | 13,517（占 24%） |

数据来源：`cordis_inspect_query` 的 `Tool.listTools`，按每个工具 JSON 序列化后的 UTF-8 字节数统计。

## 为什么停在这里

大目标都带 client 半。profile 里五个第三方插件（webrelay、persona-driven、dsh-diagram、eye-comfort、bili-scroll）的 `package.json` 都有 `dsh.client` 段，client 由包清单挂载，`apply()` 拿不到。所以「从 bundles 移除目标插件、让 router 独占 apply」这条路对每一个现有插件都会丢 UI。

现在它能活着，是因为 webServer 代理吞掉了 16 条重复路由（`diag.log` 里 16 行 skipped）。寄生可以拿到工具，但拿不到 UI；要拿 UI 就得自己实现 client，那已经超出「路由」的范围。

## 替代方案（已实现）

`system-prompt/assemble` 的 waterfall 能改 `assembly.tools`，直接在装配时裁剪工具 schema。原插件照常加载，UI、路由、生命周期都不动，实测 `toolsTokens` 从 11,961 降到 9,315。详见 `docs/进度.md`。

## 未验证

- `mode: "ptc"` 切换后工具调用的实际形态与收益
- client 半到底绑 `bundles` 还是 `dependencies`
