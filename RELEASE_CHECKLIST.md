# dsh-docintel 发布操作清单（等门槛时间后照做）

> 仓库创建于 2026-08-20 14:31（UTC 07:31），**满 1 天 ≈ 明天 14:31 之后**。
> 其余都已就绪（GitHub 推送 ✅ / awesome 条目 ✅ / PR 分支 ✅）。

## ① 现在就能做（1 分钟）：加 topic

打开 https://github.com/LL-cmyk-so/dsh-docintel
→ 右侧 **齿轮图标（Topics）**
→ 输入 `dsh-plugin`，回车添加（可顺带加 `deepseek-harness`、`knowledge-base`）
→ **Save changes**

CI 会检查 `dsh-plugin` topic，不加会挂。

## ② 明天 14:31 之后（二选一）

### 方案 A：现在先开 PR，明天只点 re-run（推荐，跟你上次 balance-widget 一样）

1. 打开 PR 对比页：
   https://github.com/LL-cmyk-so/awesome-dsh-plugin/compare/main...dsh-docintel
2. 标题：`add: LL-cmyk-so/dsh-docintel — personal document knowledge base for DSH (docs)`
3. 描述（可直接抄）：
   > Adds [dsh-docintel](https://github.com/LL-cmyk-so/dsh-docintel) to the docs category: a personal document knowledge base for DSH — PDF/Markdown/text into a local SQLite FTS5 store with page-level locators, Chinese-friendly retrieval (2-char queries included), web drawer with drag-drop upload & search, and page-cited answers from the agent. Zero Python, zero external services.
4. 点 **Create pull request**（此时 CI 会挂在 repo age 门槛上，**这是预期的**）
5. **明天 14:31 后**：PR 页面 → 底部 **Details** 里的失败检查 → **Re-run jobs**
6. CI 变绿 → **Merge pull request**

### 方案 B：明天再开 PR（CI 一次过，更干净）

明天 14:31 后，按方案 A 的 1–4 步操作，CI 直接绿 → merge。

## ③ 可选：npm 发布（随时可做，不急）

```sh
cd "/Users/hill/Nutstore Files/.symlinks/坚果云/dsh-illu-workspace/dsh-docintel"
npm login        # 需要 npm 账号（没有就 npm adduser 注册）
npm publish      # 发布后 dsh plugin add dsh-docintel 走 npm 安装
```

## 合并后的自动动作（无需操作）

- awesome 网站自动重建，条目出现在 Docs & Rendering
- 你的仓库会显示 awesome 徽章（README 有链接的话）

---

## 已就绪确认（不用再动）

| 项 | 状态 |
|---|---|
| [LL-cmyk-so/dsh-docintel](https://github.com/LL-cmyk-so/dsh-docintel) 仓库 | ✅ 10 commits，README/LICENSE/dsh.bundle 齐全 |
| awesome 条目 `data/plugins/LL-cmyk-so__dsh-docintel.yml` | ✅ docs 分类，中英文描述 |
| README.md / README.zh.md 重新生成 | ✅ 1474 条目 |
| PR 分支 `dsh-docintel`（基于 main） | ✅ 已 push 到远程 |
| 本地 git | ✅ 已回到 main 分支，工作区干净 |
