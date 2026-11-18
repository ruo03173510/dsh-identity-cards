# dsh-file-vault

本地文件索引。原始文件不动，只维护「有什么」；数据库是缓存，清单是真相。

## 装

需要 Node 24（DSH 桌面版捆绑的 runtime 就是这个版本）。

```bash
node src/cli.mjs root add desktop "C:\Users\你\Desktop"
node src/cli.mjs register "C:\Users\你\Desktop"
```

数据库默认在 `~/.dsh/vault/vault.db`，可用 `VAULT_HOME` 改。

## 用

```bash
vault root list
vault register <路径...>          # 增量，只读元数据
vault find <查询> --limit 8
vault show <id> --text
vault verify                      # missing / moved / new
vault export                      # 写 manifest.jsonl
vault import <manifest.jsonl>
vault stats
```

`--json` 输出机器可读格式。

## 排除规则

默认跳过八类目录：`.git`、`node_modules`、`__pycache__`、`.venv`、`_tmp`、`.collab`、`.vscode`、`texlive`；以及 `~$*`、`desktop.ini`、`.lnk`、`.zip`、`.rar`、`.7z`、`.cab`、`.iso`、`.onnx`、`.sh`。

额外排除写在 `~/.dsh/vault/exclude.json`：

```json
{
  "dirs": ["娱乐"],
  "filePatterns": ["\\.psd$"]
}
```

`register --all` 关闭全部排除。注册结果里的 `skipped_dirs` / `skipped_files` 会列出跳过了什么，别只看 `scanned`。

## 特征与摘要

都在注册时算，查询时零成本：

- 特征：大小、修改日期、扩展名、所在目录。
- 摘要：文本类取开头 120 字符；docx / pptx / xlsx 解压 zip 取正文首段，零依赖。
- 图片、pdf、音视频没有摘要，它们本来就没有可读文本。

```bash
vault find 实验4 --meta
```

`--meta` 每条多一行日期和摘要，8 条约多 320 token，只在分不清是哪个文件时用。

抽不出内容时存空串表示「算过但没有」，跟「还没算过」的 null 分开，下次注册不会重算。

## 迁移

`manifest.jsonl` 是纯文本、相对路径、可进私有 git。换机器：

1. clone 清单仓库；
2. `vault root add desktop <新路径>`；
3. `vault import manifest.jsonl`。

删掉 `vault.db` 也能从文件系统重建。

## 自检与基准

```bash
node test/selftest.mjs
node bench/bench.mjs
```

基准结果写 `_tmp/bench/result.json`，合成数据可复用。

## 设计取舍

- 不用 FTS5 trigram：中文两字查询命中不了，实测 0 条；改用 bigram 倒排。
- 查询走 `grams` 索引，不把全表取到内存。
- 注册只读文件头 4 KB 算指纹，不读正文。
- 不常驻：每次调用起进程、跑完退出。

## 已知限制

- 正文检索未做，`show --text` 只读前 4 KB。
- 标签表建了但未开放命令。
- 重定位靠「大小 + 创建时间」，极少数情况下会误配。
- 查询延迟随索引总量线性增长（50k 时 p95 约 38 ms），压到亚线性要维护 df 表。
- Windows 专用路径处理，未在 Linux/macOS 测。
