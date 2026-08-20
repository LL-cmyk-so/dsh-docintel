/**
 * dsh-docintel — host half.
 *
 * Registers three model tools on ctx.tools:
 *   doc_add     — parse a file (or directory) in the workspace into the local
 *                 SQLite knowledge base (page-level locators preserved).
 *   doc_search  — dual-channel Chinese-friendly retrieval; returns chunks with
 *                 locator metadata + highlighted snippets.
 *   doc_status  — list indexed documents.
 *
 * Storage defaults to <workspaceRoot>/.dsh-docintel/kb.sqlite — a plain,
 * open-format SQLite database so other plugins (book-distiller, financial
 * report analysis, …) can read the same knowledge asset.
 *
 * Deliberately imports NO @deepseek-ai/* packages (same choice as
 * dsh-balance-widget): the plugin then resolves from any profile layout.
 * Only dependency: pdfjs-dist (pure JS, no native/Python).
 */

import { openStore } from "./store.js";
import { parseFile, isSupportedPath } from "./parser.js";
import { chunkParas } from "./chunker.js";
import { makeDocintelRoutes } from "./api.js";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Stable cordis plugin name. */
export const name = "docintel";

/** Services required before the tools surface can mount. */
export const inject = ["tools"];

const CONFIG_FIELDS = {
	storageDir: "string",     // dir under workspaceRoot holding kb.sqlite
	workspaceRoot: "string",  // "" ⇒ process.cwd() at startup
	chunkChars: "number",     // chunk character budget
	defaultK: "number"        // doc_search default result count
};
const CONFIG_DEFAULTS = {
	storageDir: ".dsh-docintel",
	workspaceRoot: "",
	chunkChars: 2000,
	defaultK: 5
};

export const Config = {
	"~standard": {
		version: 1,
		vendor: "dsh-docintel",
		validate(value) {
			if (value === void 0 || value === null) value = {};
			if (typeof value !== "object") {
				return { issues: [{ message: "config must be an object", path: [] }] };
			}
			const out = {};
			for (const [key, type] of Object.entries(CONFIG_FIELDS)) {
				const raw = value[key];
				const fallback = CONFIG_DEFAULTS[key];
				if (raw === void 0 || raw === null) {
					out[key] = fallback;
					continue;
				}
				if (type === "string" && typeof raw === "string" && raw !== "") {
					out[key] = raw;
				} else if (type === "number" && typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
					out[key] = raw;
				} else {
					out[key] = fallback;
				}
			}
			return { value: out };
		}
	},
	shape: CONFIG_FIELDS,
	defaults: CONFIG_DEFAULTS
};

function resolveConfig(raw) {
	const value = raw ?? {};
	return {
		storageDir: value.storageDir ?? CONFIG_DEFAULTS.storageDir,
		workspaceRoot: value.workspaceRoot ?? CONFIG_DEFAULTS.workspaceRoot,
		chunkChars: value.chunkChars ?? CONFIG_DEFAULTS.chunkChars,
		defaultK: value.defaultK ?? CONFIG_DEFAULTS.defaultK
	};
}

/** sha256 of file bytes (dedupe / refresh key). */
async function sha256Of(filePath) {
	const buf = await readFile(filePath);
	return createHash("sha256").update(buf).digest("hex");
}

/** Resolve an input path strictly inside the workspace root. */
export function resolveWithinWorkspace(input, workspaceRoot) {
	const resolved = isAbsolute(input) ? resolve(input) : resolve(workspaceRoot, input);
	const rel = relative(workspaceRoot, resolved);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`路径必须在工作区内: ${input}`);
	}
	return resolved;
}

/** Recursively collect supported files under a directory. */
async function collectFiles(dir, recursive) {
	const out = [];
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue; // hidden / .git / .dsh-docintel …
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (recursive) out.push(...(await collectFiles(full, true)));
		} else if (entry.isFile() && isSupportedPath(full)) {
			out.push(full);
		}
	}
	return out;
}

/** One file → store; returns a per-file outcome line. */
export async function indexOneFile(filePath, store, chunkChars, workspaceRoot) {
	const info = await stat(filePath);
	const sha = await sha256Of(filePath);
	const fileText = extname(filePath).toLowerCase() === ".pdf" ? "" : await readFile(filePath, "utf8");
	const parsed = await parseFile(filePath, fileText);
	const chunks = chunkParas(parsed.paras, chunkChars);
	const result = store.addDocument({
		path: filePath,
		name: basename(filePath),
		kind: parsed.kind,
		sha256: sha,
		pages: parsed.pages,
		chars: parsed.chars,
		chunks
	});
	const rel = relative(workspaceRoot, filePath);
	const loc = parsed.kind === "pdf" ? `${parsed.pages} 页 / ${parsed.paras.length} 段` : `${parsed.chars} 字符`;
	if (result.status === "skipped") {
		return { ok: true, skipped: true, line: `- ${rel}（跳过：${result.reason}）` };
	}
	return {
		ok: true,
		line: `- ${rel}（${loc} → ${result.chunks} 块，${result.status === "updated" ? "已更新" : "已入库"}）`
	};
}

/** Build the doc_add tool. */
function buildAddTool(store, config, workspaceRoot) {
	return {
		name: "doc_add",
		description:
			"把工作区内的文件（PDF/Markdown/文本/CSV/JSON）解析后加入个人知识库（本地 SQLite，带页码定位）。" +
			"支持传单个文件路径或目录（recursive=true 时递归）。同一文件内容不变时自动跳过，内容变化时自动更新。" +
			"入库后可用 doc_search 检索。PDF 为扫描版/图片版时会报错（v0.3 将支持 OCR）。",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "文件或目录路径（相对工作区或绝对路径，必须在工作区内）"
				},
				recursive: {
					type: "boolean",
					description: "path 为目录时是否递归遍历子目录。默认 false（只处理目录下一层）"
				}
			},
			required: ["path"]
		},
		async execute(args, exec) {
			const input = String(args?.path ?? "").trim();
			if (!input) {
				return { summary: "错误：缺少 path 参数，用法：doc_add path=<文件或目录路径> [recursive=true]", added: 0, updated: 0, skipped: 0, failed: 0, total: 0, files: [], dbPath: store.dbPath };
			}
			try {
				// 相对路径按会话 cwd 解析（web 会话的 cwd 是工作区；headless
				// 无会话时回退进程 cwd）。守卫仍以 workspaceRoot 为准。
				const sessionCwd = exec?.agent?.session?.header?.cwd || process.cwd();
				const abs = isAbsolute(input) ? input : resolve(sessionCwd, input);
				const resolved = resolveWithinWorkspace(abs, workspaceRoot);
				const info = await stat(resolved);
				const files = info.isDirectory() ? await collectFiles(resolved, !!args?.recursive) : [resolved];
				if (files.length === 0) {
					return { summary: `没有找到支持的文件类型（支持: .pdf .md .markdown .txt .text .csv .json）：${input}`, added: 0, updated: 0, skipped: 0, failed: 0, total: 0, files: [], dbPath: store.dbPath };
				}
				const lines = [];
				const fileOutcomes = [];
				let added = 0;
				let updated = 0;
				let skipped = 0;
				let failed = 0;
				for (const file of files) {
					try {
						const outcome = await indexOneFile(file, store, config.chunkChars, workspaceRoot);
						lines.push(outcome.line);
						fileOutcomes.push({ path: relative(workspaceRoot, file), status: outcome.skipped ? "skipped" : outcome.line.includes("已更新") ? "updated" : "added", chunks: outcome.chunks ?? 0 });
						if (outcome.skipped) skipped += 1;
						else if (outcome.line.includes("已更新")) updated += 1;
						else added += 1;
					} catch (error) {
						failed += 1;
						lines.push(`- ${relative(workspaceRoot, file)}（失败：${error instanceof Error ? error.message : String(error)}）`);
						fileOutcomes.push({ path: relative(workspaceRoot, file), status: "failed", error: error instanceof Error ? error.message : String(error) });
					}
				}
				const summary = [
					`入库完成：新增 ${added}，更新 ${updated}，跳过 ${skipped}，失败 ${failed}（共 ${files.length} 个文件）`,
					...lines,
					`知识库位置: ${store.dbPath}`
				].join("\n");
				return { summary, added, updated, skipped, failed, total: files.length, files: fileOutcomes, dbPath: store.dbPath };
			} catch (error) {
				return { summary: `doc_add 失败：${error instanceof Error ? error.message : String(error)}`, added: 0, updated: 0, skipped: 0, failed: 0, total: 0, files: [], dbPath: store.dbPath };
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					summary: { type: "string" },
					added: { type: "integer" },
					updated: { type: "integer" },
					skipped: { type: "integer" },
					failed: { type: "integer" },
					total: { type: "integer" },
					dbPath: { type: "string" },
					files: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								path: { type: "string" },
								status: { type: "string" },
								chunks: { type: "integer" },
								error: { type: "string" }
							},
							required: ["path", "status"]
						}
					}
				},
				required: ["summary", "added", "updated", "skipped", "failed", "total", "dbPath", "files"]
			},
			render: (_args, value) => [{ type: "text", text: value.summary }]
		}
	};
}

/** Build the doc_search tool. */
function buildSearchTool(store, config) {
	return {
		name: "doc_search",
		description:
			"在个人知识库中检索文档内容（中文友好：2字词与长词均可命中）。返回 top-k 条带定位的片段，每条含文件名、页码/段号、章节与高亮摘要。" +
			"回答用户基于知识库的问题时，请按「来源：<文件名> 第<页码>页」的格式标注引用，只有确属检索结果的结论才标注来源。",
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "检索词/短语，如「现金流」「毛利率」「万科 2024 业绩」"
				},
				k: {
					type: "number",
					description: "返回条数，1-10，默认 5"
				}
			},
			required: ["query"]
		},
		async execute(args) {
			const query = String(args?.query ?? "").trim();
			if (!query) return { query: "", count: 0, results: [] };
			const k = Number(args?.k) || config.defaultK;
			const rows = store.search(query, k);
			if (rows.length === 0) {
				return {
					query,
					count: 0,
					results: [],
					note: `没有找到与「${query}」相关的内容。可尝试：① 换更短的词；② 确认先用 doc_add 把文件加入知识库；③ 用 doc_status 查看已入库文档。`
				};
			}
			const results = rows.map((r) => ({
				name: r.name,
				page: r.page,
				para: r.para,
				section: r.section,
				snippet: r.snippet
			}));
			const lines = results.map((r, i) => {
				const loc = r.page ? `第${r.page}页` : r.para ? `第${r.para}段` : "全文";
				const sec = r.section ? ` · ${r.section}` : "";
				return `[${i + 1}] ${r.name} · ${loc}${sec}\n    ${r.snippet}`;
			});
			return {
				query,
				count: results.length,
				results,
				summary: [`检索「${query}」找到 ${results.length} 条结果：`, ...lines, "引用格式：来源：<文件名> 第<页码>页"].join("\n")
			};
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					query: { type: "string" },
					count: { type: "integer" },
					summary: { type: "string" },
					note: { type: "string" },
					results: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								name: { type: "string" },
								page: { oneOf: [{ type: "integer" }, { type: "null" }] },
								para: { oneOf: [{ type: "integer" }, { type: "null" }] },
								section: { oneOf: [{ type: "string" }, { type: "null" }] },
								snippet: { type: "string" }
							},
							required: ["name", "snippet"]
						}
					}
				},
				required: ["query", "count", "results"]
			},
			render: (_args, value) => [{ type: "text", text: value.summary ?? value.note ?? `检索「${value.query}」找到 ${value.count} 条结果` }]
		}
	};
}

/** Build the doc_status tool. */
function buildStatusTool(store) {
	return {
		name: "doc_status",
		description: "列出个人知识库中已入库的文档（文件名、类型、页数/字数、块数、更新时间）与知识库位置。",
		parameters: {
			type: "object",
			properties: {}
		},
		async execute() {
			const docs = store.listDocuments();
			if (docs.length === 0) {
				return {
					count: 0,
					dbPath: store.dbPath,
					docs: [],
					note: `知识库为空（位置：${store.dbPath}）。用 doc_add 把文件加入知识库，例如：doc_add path=年报.PDF`
				};
			}
			const lines = docs.map((d) => {
				const size = d.kind === "pdf" ? `${d.pages} 页` : `${d.chars} 字符`;
				const when = new Date(d.updated_at).toLocaleString("zh-CN", { hour12: false });
				return `- ${d.name}（${d.kind} · ${size} · ${d.chunks} 块 · ${when}）`;
			});
			return {
				count: docs.length,
				dbPath: store.dbPath,
				docs: docs.map((d) => ({ name: d.name, kind: d.kind, pages: d.pages, chars: d.chars, chunks: d.chunks, updated_at: d.updated_at })),
				summary: [`已入库 ${docs.length} 个文档：`, ...lines, `知识库位置: ${store.dbPath}`].join("\n")
			};
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					count: { type: "integer" },
					dbPath: { type: "string" },
					note: { type: "string" },
					summary: { type: "string" },
					docs: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								name: { type: "string" },
								kind: { type: "string" },
								pages: { oneOf: [{ type: "integer" }, { type: "null" }] },
								chars: { type: "integer" },
								chunks: { type: "integer" },
								updated_at: { type: "integer" }
							},
							required: ["name", "kind", "chunks", "updated_at"]
						}
					}
				},
				required: ["count", "dbPath", "docs"]
			},
			render: (_args, value) => [{ type: "text", text: value.summary ?? value.note ?? `已入库 ${value.count} 个文档` }]
		}
	};
}

/** Cordis plugin apply: open the store and register the three tools. */
export function apply(ctx, config) {
	const resolved = resolveConfig(config);
	const workspaceRoot = resolved.workspaceRoot
		? resolve(resolved.workspaceRoot)
		: process.cwd();
	const dbPath = join(workspaceRoot, resolved.storageDir, "kb.sqlite");
	const store = openStore(dbPath, { chunkChars: resolved.chunkChars });

	const disposers = [];
	try {
		disposers.push(ctx.tools.register(buildAddTool(store, resolved, workspaceRoot)));
		disposers.push(ctx.tools.register(buildSearchTool(store, resolved)));
		disposers.push(ctx.tools.register(buildStatusTool(store)));
		ctx.logger?.debug?.("[dsh-docintel] three tools registered");
	} catch (error) {
		ctx.logger?.warn?.("[dsh-docintel] tool registration failed: %s", error instanceof Error ? error.message : String(error));
	}

	ctx.effect(() => () => {
		for (const dispose of disposers) {
			if (typeof dispose === "function") dispose();
		}
		store.close();
	}, "dsh-docintel: store + tools");

	// v0.2: register the web panel routes when a webServer exists (web profile).
	// headless profiles have no webServer — the conditional inject keeps the
	// tools working there without forcing the plugin to wait on the service.
	ctx.inject?.(["webServer"], (webCtx) => {
		const routeDisposers = makeDocintelRoutes(webCtx, store, resolved, workspaceRoot, indexOneFile)
			.map((route) => webCtx.webServer.register(route));
		ctx.effect(() => () => {
			for (const dispose of routeDisposers) {
				if (typeof dispose === "function") dispose();
			}
		}, "dsh-docintel: web routes");
	});
}
