/**
 * dsh-docintel — client half (web).
 *
 * A sidebar footer button ("知识库") that opens a simple right-side drawer:
 *   ① search box  → GET /api/docintel/search?q=…
 *   ② results     → file name + page + highlighted snippet
 *   ③ drop zone   → FileReader base64 → POST /api/docintel/upload
 *   ④ doc list    → GET /api/docintel/docs
 *
 * Deliberately minimal: no PDF preview, no delete, no settings — four
 * elements, one per v0.1 capability, nothing new to learn.
 *
 * Hand-written as a __ModuleLoader__ bundle (same format as dsh-balance-widget):
 * no JSX, no build step, no runtime dependencies beyond react.
 */

window.__ModuleLoader__.load({
	id: "dsh-docintel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let React = react;
		//#region styles
		const css = [
			".dshdi_btn{display:flex;align-items:center;gap:6px;width:100%;padding:6px 8px;margin:0 8px 4px;border:none;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;font-family:inherit;font-size:12px;line-height:18px;text-align:left}",
			".dshdi_btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dshdi_overlay{position:fixed;inset:0;z-index:90;background:rgba(0,0,0,.35)}",
			".dshdi_panel{position:fixed;top:0;right:0;bottom:0;width:min(420px,92vw);z-index:91;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-3);border-left:1px solid var(--dsw-alias-border-l3);box-shadow:-8px 0 24px rgba(0,0,0,.15);font-family:inherit}",
			".dshdi_head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
			".dshdi_title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}",
			".dshdi_close{background:none;border:none;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:18px;line-height:1;padding:2px 6px;font-family:inherit}",
			".dshdi_close:hover{color:var(--dsw-alias-label-primary)}",
			".dshdi_body{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:14px}",
			".dshdi_search{display:flex;gap:8px}",
			".dshdi_input{flex:1;min-width:0;padding:7px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;font-family:inherit}",
			".dshdi_input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}",
			".dshdi_go{border:none;border-radius:8px;padding:0 14px;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-inverse,#fff);cursor:pointer;font-size:13px;font-family:inherit}",
			".dshdi_go:hover{opacity:.9}",
			".dshdi_section{font-size:11px;color:var(--dsw-alias-label-tertiary);text-transform:uppercase;letter-spacing:.04em}",
			".dshdi_result{padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}",
			".dshdi_resultLoc{font-size:11px;font-weight:600;color:var(--dsw-alias-state-business-primary);margin-bottom:3px}",
			".dshdi_resultSec{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-left:6px;font-weight:400}",
			".dshdi_resultBody{font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary);word-break:break-all}",
			".dshdi_empty{font-size:12px;color:var(--dsw-alias-label-tertiary);padding:6px 0}",
			".dshdi_drop{border:1.5px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:18px 12px;text-align:center;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:border-color .15s,background .15s}",
			".dshdi_drop:hover,.dshdi_drop[data-over=true]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}",
			".dshdi_hint{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:4px}",
			".dshdi_doc{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;font-size:12px;color:var(--dsw-alias-label-primary)}",
			".dshdi_doc:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dshdi_docName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dshdi_docMeta{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
			".dshdi_groupHead{display:flex;align-items:center;gap:6px;width:100%;border:none;background:none;cursor:pointer;padding:5px 2px;font-family:inherit;font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".dshdi_groupHead:hover{color:var(--dsw-alias-label-primary)}",
			".dshdi_groupArrow{font-size:10px;color:var(--dsw-alias-label-tertiary)}",
			".dshdi_groupTitle{font-weight:600}",
			".dshdi_del{display:none;border:none;background:none;cursor:pointer;font-size:12px;padding:2px 6px;border-radius:6px;color:var(--dsw-alias-label-secondary);font-family:inherit;line-height:1.4}",
			".dshdi_doc:hover .dshdi_del{display:inline-flex}",
			".dshdi_del:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dshdi_delConfirm{display:inline-flex;background:var(--dsw-alias-state-error-primary);color:#fff;font-size:11px}",
			".dshdi_delConfirm:hover{background:var(--dsw-alias-state-error-primary);opacity:.9}",
			".dshdi_note{font-size:11px;color:var(--dsw-alias-state-warn-primary);line-height:16px}",
			".dshdi_err{font-size:11px;color:var(--dsw-alias-state-error-primary);line-height:16px}"
		].join("");
		const tagId = "dsh-docintel/styles.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-docintel";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		const styles = {
			btn: "dshdi_btn", overlay: "dshdi_overlay", panel: "dshdi_panel",
			head: "dshdi_head", title: "dshdi_title", close: "dshdi_close",
			body: "dshdi_body", search: "dshdi_search", input: "dshdi_input", go: "dshdi_go",
			section: "dshdi_section", result: "dshdi_result", resultLoc: "dshdi_resultLoc",
			resultSec: "dshdi_resultSec", resultBody: "dshdi_resultBody", empty: "dshdi_empty",
			drop: "dshdi_drop", hint: "dshdi_hint", doc: "dshdi_doc", docName: "dshdi_docName",
			docMeta: "dshdi_docMeta", groupHead: "dshdi_groupHead", groupArrow: "dshdi_groupArrow",
			groupTitle: "dshdi_groupTitle", del: "dshdi_del", delConfirm: "dshdi_delConfirm",
			note: "dshdi_note", err: "dshdi_err"
		};
		//#endregion
		//#region locale
		const NS = "docintel";
		const zh = {
			button: "📚 知识库",
			title: "知识库",
			close: "关闭",
			searchPlaceholder: "搜索知识库：输入关键词…",
			search: "搜索",
			searching: "搜索中…",
			results: "检索结果",
			noResults: "没有找到相关内容。试试换更短的词，或用 doc_add 先入库。",
			upload: "拖拽文件到这里，或点击选择文件",
			uploadHint: "支持 PDF / DOCX / MD / TXT / CSV / JSON",
			uploading: "入库中…",
			uploadDone: "已入库",
			docs: "已入库文档",
			noDocs: "知识库为空——拖一个文件进来，或让 agent 用 doc_add。",
			docFilter: "过滤文档名…",
			pdfGroup: "📄 PDF 文档",
			txtGroup: "📝 文本 / 其他",
			delete: "从知识库删除",
			confirmDelete: "确认删除？",
			deleted: "已删除",
			loadFailed: "加载失败：",
			emptyQuery: "请输入搜索词"
		};
		const en = {
			button: "📚 KB",
			title: "Knowledge Base",
			close: "Close",
			searchPlaceholder: "Search the knowledge base…",
			search: "Search",
			searching: "Searching…",
			results: "Results",
			noResults: "Nothing found. Try a shorter term, or doc_add a file first.",
			upload: "Drop files here, or click to pick",
			uploadHint: "PDF / DOCX / MD / TXT / CSV / JSON",
			uploading: "Indexing…",
			uploadDone: "Indexed",
			docs: "Documents",
			noDocs: "KB is empty — drop a file, or ask the agent to doc_add.",
			docFilter: "Filter by name…",
			pdfGroup: "📄 PDF",
			txtGroup: "📝 Text / Other",
			delete: "Remove from KB",
			confirmDelete: "Confirm?",
			deleted: "Removed",
			loadFailed: "Load failed: ",
			emptyQuery: "Type a query first"
		};
		//#endregion
		//#region helpers
		/** Highlight **word** markers in a snippet as <mark> elements. */
		function renderSnippet(snippet) {
			const parts = String(snippet ?? "").split("**");
			const nodes = [];
			for (let i = 0; i < parts.length; i++) {
				if (!parts[i]) continue;
				nodes.push(
					i % 2 === 1
						? React.createElement("mark", { key: i, style: { background: "var(--dsw-alias-state-business-primary)", color: "#fff", borderRadius: 2, padding: "0 2px" } }, parts[i])
						: parts[i]
				);
			}
			return nodes;
		}
		const API = {
			docs: "/api/docintel/docs",
			search: "/api/docintel/search",
			upload: "/api/docintel/upload",
			delete: "/api/docintel/delete"
		};
		async function fetchJson(url, init) {
			const res = await fetch(url, init);
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(payload.error ?? `${res.status}`);
			return payload;
		}
		/** Format doc size: PDF → "143页", others → "" (keep it human, no tech jargon). */
		function docMeta(d) {
			return d.kind === "pdf" && d.pages ? `${d.pages}页` : "";
		}
		/** One collapsible group (e.g. PDFs) with its document rows. */
		function renderDocGroup({ key, title, open, toggle, items, onDelete, confirmId, t }) {
			return React.createElement("div", { key }, [
				React.createElement("button", {
					key: "h",
					type: "button",
					className: styles.groupHead,
					onClick: toggle
				}, [
					React.createElement("span", { key: "a", className: styles.groupArrow }, open ? "▾" : "▸"),
					React.createElement("span", { key: "t", className: styles.groupTitle }, title)
				]),
				open && items.map((d, i) => React.createElement("div", { key: i, className: styles.doc }, [
					React.createElement("span", { key: "n", className: styles.docName }, d.name),
					React.createElement("span", { key: "m", className: styles.docMeta }, docMeta(d)),
					React.createElement("button", {
						key: "d",
						type: "button",
						className: confirmId === d.id ? `${styles.del} ${styles.delConfirm}` : styles.del,
						title: t("delete"),
						onClick: (e) => { e.stopPropagation(); onDelete(d.id, d.name); }
					}, confirmId === d.id ? t("confirmDelete") : "🗑")
				]))
			]);
		}
		//#endregion
		//#region KnowledgeDrawer
		function KnowledgeDrawer({ onClose, t }) {
			const [query, setQuery] = React.useState("");
			const [results, setResults] = React.useState(null); // null = 未搜
			const [searching, setSearching] = React.useState(false);
			const [docs, setDocs] = React.useState([]);
			const [uploading, setUploading] = React.useState(false);
			const [dropOver, setDropOver] = React.useState(false);
			const [note, setNote] = React.useState("");
			const [error, setError] = React.useState("");
			const [docFilter, setDocFilter] = React.useState("");
			const [pdfOpen, setPdfOpen] = React.useState(true);
			const [txtOpen, setTxtOpen] = React.useState(true);
			const [confirmId, setConfirmId] = React.useState(null);
			const fileInputRef = React.useRef(null);

			const loadDocs = async () => {
				try {
					const payload = await fetchJson(API.docs);
					setDocs(payload.docs ?? []);
				} catch (err) {
					setError(`${t("loadFailed")}${err.message}`);
				}
			};
			React.useEffect(() => {
				loadDocs();
			}, []);

			// group + filter the doc list
			const filterText = docFilter.trim().toLowerCase();
			const allFiltered = filterText
				? docs.filter((d) => d.name.toLowerCase().includes(filterText))
				: docs;
			const pdfs = allFiltered.filter((d) => d.kind === "pdf");
			const texts = allFiltered.filter((d) => d.kind !== "pdf");

			const doSearch = async (q) => {
				const term = (q ?? query).trim();
				if (!term) {
					setError(t("emptyQuery"));
					return;
				}
				setSearching(true);
				setError("");
				try {
					const payload = await fetchJson(`${API.search}?q=${encodeURIComponent(term)}&k=5`);
					setResults(payload.results ?? []);
				} catch (err) {
					setError(`${t("loadFailed")}${err.message}`);
					setResults([]);
				} finally {
					setSearching(false);
				}
			};

			const uploadOne = async (file) => {
				const base64 = await new Promise((resolve, reject) => {
					const reader = new FileReader();
					reader.onload = () => {
						const result = String(reader.result ?? "");
						const idx = result.indexOf(",");
						resolve(idx >= 0 ? result.slice(idx + 1) : result);
					};
					reader.onerror = () => reject(reader.error);
					reader.readAsDataURL(file);
				});
				const payload = await fetchJson(API.upload, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name: file.name, base64 })
				});
				return payload;
			};

			const handleFiles = async (fileList) => {
				const files = Array.from(fileList ?? []);
				if (files.length === 0) return;
				setUploading(true);
				setError("");
				setNote("");
				try {
					for (const file of files) {
						try {
							const payload = await uploadOne(file);
							setNote((n) => `${n ? n + "；" : ""}${file.name}: ${payload.status === "skipped" ? "已存在" : t("uploadDone")}`);
						} catch (err) {
							setNote((n) => `${n ? n + "；" : ""}${file.name}: ${err.message}`);
						}
					}
					await loadDocs();
				} finally {
					setUploading(false);
				}
			};

			/** Two-step delete: first click arms confirm, second click deletes. */
			const handleDelete = async (id, name) => {
				if (confirmId !== id) {
					setConfirmId(id);
					return;
				}
				setConfirmId(null);
				try {
					const payload = await fetchJson(API.delete, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ id })
					});
					setNote((n) => `${n ? n + "；" : ""}${t("deleted")} ${name}`);
					if (payload.removed) await loadDocs();
				} catch (err) {
					setError(`${t("loadFailed")}${err.message}`);
				}
			};

			const onDrop = (event) => {
				event.preventDefault();
				setDropOver(false);
				handleFiles(event.dataTransfer?.files);
			};

			return React.createElement("div", null, [
				React.createElement("div", {
					key: "overlay",
					className: styles.overlay,
					onClick: onClose
				}),
				React.createElement("div", { key: "panel", className: styles.panel }, [
					React.createElement("div", { key: "head", className: styles.head }, [
						React.createElement("span", { key: "t", className: styles.title }, t("title")),
						React.createElement("button", {
							key: "x",
							type: "button",
							className: styles.close,
							onClick: onClose,
							title: t("close")
						}, "×")
					]),
					React.createElement("div", { key: "body", className: styles.body }, [
						// ① search
						React.createElement("div", { key: "search", className: styles.search }, [
							React.createElement("input", {
								key: "input",
								className: styles.input,
								placeholder: t("searchPlaceholder"),
								value: query,
								onChange: (e) => setQuery(e.target.value),
								onKeyDown: (e) => { if (e.key === "Enter") doSearch(); }
							}),
							React.createElement("button", {
								key: "go",
								type: "button",
								className: styles.go,
								onClick: () => doSearch(),
								disabled: searching
							}, searching ? t("searching") : t("search"))
						]),
						// ② results
						results !== null && React.createElement("div", { key: "results" }, [
							React.createElement("div", { key: "sec", className: styles.section }, `${t("results")}（${results.length}）`),
							results.length === 0
								? React.createElement("div", { key: "empty", className: styles.empty }, t("noResults"))
								: results.map((r, i) => React.createElement("div", {
									key: i,
									className: styles.result
								}, [
									React.createElement("div", { key: "loc", className: styles.resultLoc }, [
										r.name,
										r.page ? ` · 第${r.page}页` : r.para ? ` · 第${r.para}段` : "",
										r.section ? React.createElement("span", { key: "sec", className: styles.resultSec }, r.section) : null
									]),
									React.createElement("div", { key: "body", className: styles.resultBody }, renderSnippet(r.snippet))
								]))
						]),
						// ③ upload
						React.createElement("div", {
							key: "upload",
							className: styles.drop,
							"data-over": dropOver,
							onClick: () => fileInputRef.current?.click(),
							onDragOver: (e) => { e.preventDefault(); setDropOver(true); },
							onDragLeave: () => setDropOver(false),
							onDrop
						}, [
							React.createElement("div", { key: "t" }, uploading ? t("uploading") : t("upload")),
							React.createElement("div", { key: "h", className: styles.hint }, t("uploadHint"))
						]),
						React.createElement("input", {
							key: "file",
							ref: fileInputRef,
							type: "file",
							multiple: true,
							style: { display: "none" },
							onChange: (e) => { handleFiles(e.target.files); e.target.value = ""; }
						}),
						// ④ doc list: filter + grouped (PDF / 文本), collapsible
						React.createElement("div", { key: "docs" }, [
							React.createElement("div", { key: "sec", className: styles.section }, `${t("docs")}（${docs.length}）`),
							docs.length === 0
								? React.createElement("div", { key: "empty", className: styles.empty }, t("noDocs"))
								: React.createElement("div", { key: "list" }, [
									React.createElement("input", {
										key: "filter",
										className: styles.input,
										placeholder: t("docFilter"),
										value: docFilter,
										onChange: (e) => setDocFilter(e.target.value)
									}),
									renderDocGroup({
										key: "pdf",
										title: `${t("pdfGroup")}（${pdfs.length}）`,
										open: pdfOpen,
										toggle: () => setPdfOpen(!pdfOpen),
										items: pdfs,
										onDelete: handleDelete,
										confirmId,
										t
									}),
									renderDocGroup({
										key: "txt",
										title: `${t("txtGroup")}（${texts.length}）`,
										open: txtOpen,
										toggle: () => setTxtOpen(!txtOpen),
										items: texts,
										onDelete: handleDelete,
										confirmId,
										t
									})
								])
						]),
						note && React.createElement("div", { key: "note", className: styles.note }, note),
						error && React.createElement("div", { key: "err", className: styles.err }, error)
					])
				])
			]);
		}
		//#endregion
		//#region SidebarButton
		function SidebarButton({ t }) {
			const [open, setOpen] = React.useState(false);
			return React.createElement("div", null, [
				React.createElement("button", {
					key: "btn",
					type: "button",
					className: styles.btn,
					title: t("title"),
					onClick: () => setOpen(true)
				}, t("button")),
				open && React.createElement(KnowledgeDrawer, {
					key: "drawer",
					t,
					onClose: () => setOpen(false)
				})
			]);
		}
		//#endregion
		//#region plugin body
		const inject = ["slots", "locale"];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-docintel: dictionaries");
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "docintel",
				order: 20,
				locale: NS
			}, SidebarButton));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
