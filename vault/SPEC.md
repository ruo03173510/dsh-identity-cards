# dsh-file-vault 第一版规格

## 目的

本地文件索引。原始文件不动，只维护「有什么」；数据库是缓存，清单是真相。

## 边界

- 只读文件系统元数据；不移动、不改名、不删除用户文件。
- 不常驻：每次调用起进程、跑完退出。
- 单个 SQLite 文件，node:sqlite 内置模块，无第三方依赖。

## 动作

| 命令 | 做什么 |
|---|---|
| `vault root add <名字> <路径>` | 登记资料根 |
| `vault root list` | 列出根 |
| `vault register <路径...>` | 注册文件或目录，增量 |
| `vault find <查询> [--limit 8] [--json]` | 检索，返回 Top-N 与命中原因 |
| `vault show <id>` | 看单个文件详情，`--text` 抽正文前 4 KB |
| `vault verify [--root <名字>]` | 对账：missing / moved / new |
| `vault export` | 写 manifest.jsonl |
| `vault stats` | 总数、扩展名分布、各根文件数 |

## 数据模型

- `roots(name, path)`：本机绝对路径，换机器只改这里。
- `files(root_id, rel_path, name, ext, size, mtime, birth, head_hash, status, first_seen, last_seen)`：rel_path 相对根，正斜杠，跨机器有效。
- `grams(g, file_id)`：name + rel_path 的 bigram 倒排，查询走索引而不是全表扫。
- `meta(k, v)`：schema_version。

## 关键判断

- 不用 FTS5 trigram：中文两字查询（「实验」）命中不了 trigram，实测 0 条。自建 bigram 覆盖 2 字。
- 查询不取全表到内存：走 `grams` 索引求交集，结果只回 Top-N。
- 增量注册：size + mtime 一致就跳过，不读文件内容。
- 迁移：manifest.jsonl 纯文本、相对路径、可进私有 git；删 vault.db 后由文件系统重建。

## 验收判据

1. `npm run selftest` 全过。
2. 1 万条记录 find p95 ≤ 50 ms（不含进程启动）。
3. 1k → 50k 查询延迟增长不超过 2 倍。
4. recall@5 ≥ 95%（合成查询集）。
5. find 单次输出 ≤ 400 token。
6. 删 vault.db 后重建，find 结果一致。
7. 移动已注册文件后 verify 报 moved 并重定位。

## 实测（2026-11-16，Windows，Node 24.21.0）

| 规模 | 注册 | find p50 | find p95 | recall@5 | db | RSS |
|---|---|---|---|---|---|---|
| 1k | 0.5 s | 0.30 ms | 0.60 ms | 100% | <1 MB | 65 MB |
| 5k | 3.7 s | 3.10 ms | 4.40 ms | 100% | <1 MB | 81 MB |
| 10k | 17.7 s | 5.76 ms | 8.64 ms | 100% | 14.5 MB | 138 MB |
| 50k | 89.5 s | 21.8 ms | 37.8 ms | 100% | 96.9 MB | 257 MB |

50k 冷启动到出结果 141 ms；manifest.jsonl 8.7 MB。

token 成本（估算：中文 1 token/字，非中文 0.3 token/字符，非真实 tokenizer）：

| 输出 | 字符 | 估算 token |
|---|---|---|
| `find --limit 8`（精简后） | 371 | 201 |
| `find --limit 8`（优化前，含 name/ext/mtime/root/score） | 807 | 371 |
| `find --json` | 1824 | 676 |
| `stats` | 262 | 79 |
| `show` | 136 | 56 |
| `verify`（健康） | 1 行汇总 | 约 10 |

`--json` 是给程序读的，不要让它进模型上下文。

结论：判据 1、2、4、5、6、7 达标。**判据 3 未达标**，1k→50k 实测 63 倍，延迟随数据量线性增长。

原因：bigram 倒排里公共词（课程名）的命中数随总量增长，`intersect` 每层都要扫一遍对应倒排。

试过并回退的方案：

| 方案 | 50k p50 | 50k p95 | 结论 |
|---|---|---|---|
| `group by ... having` | 119.7 ms | 150.6 ms | 最慢，排序开销大 |
| `intersect` 逐层求交 | 21.8 ms | 37.8 ms | 采用 |
| 采样 df 选稀有 bigram 入口 | 9.6 ms | 118.4 ms | p50 好但长尾差，回退 |

压到亚线性需要维护一张 df 表（每个 bigram 的文档频次），注册后全量重算，查询时从最稀有的 bigram 取候选。这版没做。

## 不做

向量检索、正文全文索引（第一版）、自动监听、身份卡迁移、Web UI、标签树（留表结构，先不开）。

## 运行环境

Windows，Node 24.21.0（DSH 捆绑 runtime 版本）。桌面版 `E:\dsh\resources\runtime\versions.json` 已确认。
