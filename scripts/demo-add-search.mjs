#!/usr/bin/env node
/**
 * Demo driver for the dsh-docintel tools in this agent session.
 * Runs the exact plugin code path (lib/store.js + lib/parser.js + lib/chunker.js)
 * that the host registers as the doc_add / doc_search / doc_status tools,
 * against the real KB at <workspace>/.dsh-docintel/kb.sqlite.
 *
 * Usage: node scripts/demo-add-search.mjs
 */
import { openStore } from "../lib/store.js";
import { parseFile } from "../lib/parser.js";
import { chunkParas } from "../lib/chunker.js";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const WS = join(HERE, "..");
const DB = join(WS, ".dsh-docintel", "kb.sqlite");
const TARGET = join(WS, "testdata", "山木科技_2023年报_测试.pdf");
const CHUNK_CHARS = 2000;
const K = 5;

const sha256Of = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const rel = (p) => (p.startsWith(WS) ? p.slice(WS.length + 1) : p);

function status(store, label) {
	const docs = store.listDocuments();
	console.log(`\n【doc_status${label}】`);
	if (docs.length === 0) {
		console.log(`知识库为空（位置：${store.dbPath}）。用 doc_add 把文件加入知识库。`);
		return;
	}
	for (const d of docs) {
		const size = d.kind === "pdf" ? `${d.pages} 页` : `${d.chars} 字符`;
		const when = new Date(d.updated_at).toLocaleString("zh-CN", { hour12: false });
		console.log(`- ${d.name}（${d.kind} · ${size} · ${d.chunks} 块 · ${when}）`);
	}
	console.log(`知识库位置: ${store.dbPath}`);
}

async function main() {
	const store = openStore(DB, { chunkChars: CHUNK_CHARS });
	try {
		status(store, "（之前）");

		// ── doc_add path=testdata/山木科技_2023年报_测试.pdf ──
		console.log("\n【doc_add】");
		statSync(TARGET);
		const sha = sha256Of(TARGET);
		const parsed = await parseFile(TARGET, "");
		const chunks = chunkParas(parsed.paras, CHUNK_CHARS);
		const result = store.addDocument({
			path: TARGET,
			name: basename(TARGET),
			kind: parsed.kind,
			sha256: sha,
			pages: parsed.pages,
			chars: parsed.chars,
			chunks
		});
		const loc = parsed.kind === "pdf" ? `${parsed.pages} 页 / ${parsed.paras.length} 段` : `${parsed.chars} 字符`;
		const line =
			result.status === "skipped"
				? `- ${rel(TARGET)}（跳过：${result.reason}）`
				: `- ${rel(TARGET)}（${loc} → ${result.chunks} 块，${result.status === "updated" ? "已更新" : "已入库"}）`;
		console.log(`入库完成：新增 ${result.status === "added" ? 1 : 0}，更新 ${result.status === "updated" ? 1 : 0}，跳过 ${result.status === "skipped" ? 1 : 0}，失败 0（共 1 个文件）`);
		console.log(line);
		console.log(`知识库位置: ${store.dbPath}`);

		// ── doc_search ×2 ──
		for (const q of ["现金流", "毛利率"]) {
			console.log(`\n【doc_search query="${q}"】`);
			const rows = store.search(q, K);
			if (rows.length === 0) {
				console.log(`没有找到与「${q}」相关的内容。`);
				continue;
			}
			console.log(`检索「${q}」找到 ${rows.length} 条结果：`);
			rows.forEach((r, i) => {
				const loc = r.page ? `第${r.page}页` : r.para ? `第${r.para}段` : "全文";
				const sec = r.section ? ` · ${r.section}` : "";
				console.log(`[${i + 1}] ${r.name} · ${loc}${sec}`);
				console.log(`    ${r.snippet}`);
			});
			console.log("引用格式：来源：<文件名> 第<页码>页");
		}

		status(store, "（之后）");
	} finally {
		store.close();
	}
}

main().catch((error) => {
	console.error("demo 失败:", error);
	process.exit(1);
});
