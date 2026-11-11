# 卡的格式

一张卡 = 一个目录 + 一份 `card.md`。**目录名就是卡 id**，`card.md` 开头的 frontmatter 写元信息。

```
~/.dsh/cards/
    lab-report/card.md
    code/card.md
    writer/card.md
```

## frontmatter

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 卡 id，和目录名一致 |
| `name` | ✅ | 显示名，中文短语 |
| `version` | | 卡的版本号，改卡时 +1 |
| `order` | | 在提示里的排序，小的在前 |
| `group` | | 分类，仅用于展示 |
| `trigger` | | **什么任务该用这张卡**（列表） |
| `expire` | | **什么任务不该用**（列表） |
| `related` | | 相关的卡，`reference` 时会提示 |
| `handoff` | | 收尾后可以交接给谁（列表），认卡时带一句交接提示 |
| `verify` | | 验收命令，认卡时带出 |
| `updatedAt` | | 卡的更新时间，`audit` 用它算哪张最久没动 |
| `budget` | | 建议的调用预算，仅提示 |
| `res.<名字>` | | 一条资源引用，见下节 |

`trigger` 和 `expire` 是最重要的两个字段：**它们决定了模型判不判得对**。写具体动词（"写代码""调试"），别写空话（"各种任务"）。

## 资源引用

卡只存引用，资源放别处。写法是扁平键，一个资源一行：

```yaml
res.format: shared:templates/report-format.md
res.sample: private:samples/regression.py?tier=hot
res.rules: project:course-graph/reports/rules/report.rules.json
res.font: global:fonts/SourceHanSansSC.otf@sha256:3f2a9c11
```

格式：`<作用域>:<相对路径>[?tier=hot|cold][@sha256:<前 8 位以上>]`

| 作用域 | 根 | 用途 |
|---|---|---|
| `private` | `<卡目录>/` | 跟卡走，删卡即删 |
| `shared` | `<卡库>/@shared/` | 多卡共用的模板与规则 |
| `project` | `@shared/projects.md` 里登记的项目根 | 项目数据，根变了只改表 |
| `global` | `$DSH_HOME/resources/`（`config.resourcesDir` 可改） | 机器级，跨项目 |

规则：

- 裸名不解析，必须带作用域前缀；`..` 越界直接拒绝。
- 资源坏了不影响卡加载——卡只读 `card.md`，引用在 `list` / `resolve` / `scan` 时才 stat。
- `?tier=hot` 表示每次用卡都会读，缺省 `cold`。
- `@sha256:` 可选，`scan` 时比对，不符记「内容变」并写进更新表。

运维三条命令：

```bash
identity list                              # 每张卡显示「↳ N 个引用，M 个可解析」
identity resolve id=<卡> name=<资源名>      # 这条引用解析到哪个绝对路径
identity resources mode=scan               # 扫引用、重建 @shared/resources/index.md
identity resources mode=status             # 看索引条数、断链、内容变
```

## 正文五节

```markdown
## 1. 你是谁        一句话角色，不写理念
## 2. 任务封装      开工前做什么、收尾前做什么（这是工作契约）
## 3. 输出要求      交付物、结构、语言、可验规则（这是结果契约）
## 4. 什么时候不管用  边界：什么情况该换卡
## 5. 样本          正例/反例，按路径引用，不复制
```

**第 2、3 节是契约的核心**，其余三节是让契约可执行。

## 写作要求

1. **可判定**：写"注释挂行尾"，不写"注释要写得好"。前者能检查，后者不能。
2. **带边界**：每张卡都要写"什么时候不管用"，否则它会去抢别的卡的活。
3. **不重复全局契约**：跨卡通用的规则放全局契约，别在每张卡里抄一遍。
4. **短**：一张卡 40–80 行。卡越长，被忽略的部分越多。
5. **样本引用路径，不贴内容**：贴了就会过期。

## 校验

```bash
# 列出所有卡，看解析是否正常
identity list

# 看某张卡解析出来的元信息
identity show <id>

# 审计：每张卡占多少字符、全局提示多大
identity audit
```

坏卡不会连坐：单张卡解析失败只跳过它，其余照常工作。
