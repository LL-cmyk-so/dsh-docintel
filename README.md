# dsh-docintel

个人文档知识库插件 for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）。

把工作区里的 PDF / Markdown / 文本文件解析进一个**本地 SQLite FTS5 知识库**（带页码定位），agent 通过三个工具随时检索、并**带页码引用**地回答基于你私人资料的问题。

- 零 Python、零外部服务、零配置：`node:sqlite` + `pdfjs-dist`（纯 JS）
- **页码级定位**：PDF 逐页提取保留真实页码（与 PyMuPDF 对比 ~99% 字符一致），回答可回溯原文
- **中文友好检索**：FTS5 trigram（≥3 字词，BM25 排序）+ LIKE 兜底（≤2 字词）双通道
- **开放格式**：知识库就是普通 SQLite 文件，任何脚本 / 工具可直接 `SELECT` 读取
- **Web 面板（v0.2）**：侧边栏「知识库」按钮 → 抽屉：搜索 / 结果 / 拖拽上传 / 文档列表

## 安装

```sh
# 在 profile 里加一行依赖（link 到本地目录）：
#   "dsh-docintel": "link:/path/to/dsh-docintel"
# 然后：
dsh plugin --profile web add dsh-docintel   # 或直接编辑 package.json + pnpm install
```

## 使用

### 对话中（agent 工具）

| 工具 | 作用 |
|---|---|
| `doc_add` | 把文件/目录加入知识库（自动解析、分块、去重；内容变化自动更新） |
| `doc_search` | 检索知识库，返回带文件名+页码/段号+章节+高亮摘要的 top-k 片段 |
| `doc_status` | 列出已入库文档与知识库位置 |

```text
用户：把这份文档入库
agent：→ doc_add path=2025年年度报告.PDF
      → doc_status
用户：这份报告里的现金流情况如何？
agent：→ doc_search query=现金流
      → 「据《2025年年度报告.PDF》第42页：经营现金流为负…」
```

### Web 面板（v0.2）

侧边栏底部「📚 知识库」按钮 → 抽屉：

```
┌──────────────────────────────────────────┐
│ 知识库                            [×]     │
│ [搜索：现金流、毛利率、关键词……]  (搜索) │
│ 找到 3 条：                                │
│  ▸ 2025年年度报告.PDF · 第65页             │
│     …经营现金流为负，主要系…               │
│ ┌──────────────────────────────────────┐ │
│ │   拖拽文件到这里，或点击选择文件       │ │
│ └──────────────────────────────────────┘ │
│ 已入库 7 个文档：                          │
│  📄 2025年年度报告.PDF   143页             │
└──────────────────────────────────────────┘
```

拖文件进去即入库（自动去重/更新）；搜索框即查即得（带页码可复制引用）；文档按 PDF / 文本分组、可折叠、可过滤，每行 hover 出 🗑 两段式确认删除。

## 支持的文件

| 类型 | 定位方式 |
|---|---|
| `.pdf`（文本版） | 真实页码 + 书签切章（扫描版会明确报错，v0.3 支持 OCR） |
| `.md` / `.markdown` | 标题层级 → 章节路径；空行分段 → 段号 |
| `.txt` / `.text` / `.csv` | 段号 |
| `.json` | 格式化后段号 |

## 知识库位置与格式

默认 `<workspace>/.dsh-docintel/kb.sqlite`（可通过配置 `storageDir` / `workspaceRoot` 调整）。

```sql
-- 其他插件可以直接读：
SELECT d.name, d.kind, d.pages, COUNT(c.rowid) AS chunks
FROM docs d JOIN chunks c ON c.doc_id = d.id
GROUP BY d.id;
```

## 中文检索为什么是双通道

SQLite FTS5 的 trigram tokenizer 没有 1–2 字符的索引项（实测两个字的词零命中）。因此：

- 查询含 ≥3 字词 → FTS5 `MATCH` + `bm25()` 排序（相关度好）
- 查询全部为 ≤2 字词 → `LIKE` 兜底（参数化 + 转义，安全）

两者都是确定性、离线、可解释的——不需要 embedding、不需要向量服务。

## 架构

```
┌─ client（v0.2）───────────── Web 面板（React，官方 UI primitives）
├─ host（Node，本插件）──────── doc_add / doc_search / doc_status 工具
│                              + /api/docintel/* loopback REST 路由（v0.2）
├─ store.js ────────────────── SQLite FTS5（docs + chunks 两表）
├─ parser.js ───────────────── pdfjs-dist 逐页页码提取 + 文本快速路径
└─ chunker.js ──────────────── 按字符预算分块，chunk 携带 (page/para/section)
```

## 测试

```sh
node --test                # 17 个单元测试：解析/入库/检索/去重/更新/删除
npm run e2e                # 真实年度报告 PDF 端到端（解析→入库→中文检索）
npm run test:api           # 面板 API 冒烟（docs/search/upload/delete，起真实 HTTP server）
node scripts/verify-pdfjs.mjs <file.pdf>   # pdfjs 提取质量对比基准
```

## 开发备忘：DSH 工具注册的三个坑（已踩平）

给想给 DSH 写工具插件的作者：

1. **`ctx.tools.register` 要求强制性的 `output` 声明**——缺 `output` 整个注册静默失败（工具不会出现在 agent 列表，且无报错）。每个工具必须带 `output: { schema, render }`。
2. **output.schema 必须是标准 JSON Schema 子集**：属性内 `required: true` 不被支持（要用对象级 `required: [...]` 数组）；`type` 只接受单字符串（不支持 `["integer","null"]` 数组）；nullable 用 `{ oneOf: [{ type: "integer" }, { type: "null" }] }`。
3. **Node 24 的 `node:sqlite` 的 `DatabaseSync` 没有 `filename` 属性**——要报告库路径请在打开时自己保存。

## 路线图

- **v0.1（已完成）**：文档入库（PDF/MD/TXT/CSV/JSON）+ 检索 + 状态，页码级定位，中文双通道
- **v0.2（已完成）**：Web 面板——搜索 / 拖拽上传 / 分组列表 / 删除
- **v0.3**：表格支持——Excel 结构化入库（sheet→章节、行→段落、表头列名）、按需整表读取、PDF 表格提取改善
- **v0.4**：扫描件支持（可选 OCR 档位）
- **v0.5**：知识导出——Obsidian 兼容格式、知识库互操作
- **可选**：语义检索增强（向量）

## License

MIT
