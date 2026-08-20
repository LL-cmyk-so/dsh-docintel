#!/usr/bin/env node
/**
 * dsh-docintel — end-to-end smoke test on real files.
 *
 * 1. Parses the synthetic Chinese annual-report PDF (page numbers kept).
 * 2. Parses the real Moutai annual report PDF (143 pages).
 * 3. Indexes both into a temp SQLite KB and runs Chinese retrieval
 *    (2-char, 3-char, 4-char queries) through the full tool pipeline.
 *
 * Usage: node scripts/e2e.mjs
 */
import { openStore } from "../lib/store.js";
import { parseFile } from "../lib/parser.js";
import { chunkParas } from "../lib/chunker.js";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const WS = join(HERE, "..", "..");
const SYNTHETIC = join(WS, "custom-plugins", "financial_report_analysis", "tests", "山木科技_2023年报_测试.pdf");
const MOUTAI = join(WS, "financial_report_analysis插件用财报暂存", "贵州茅台2025年财报.PDF");

const sha256Of = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

async function main() {
	console.log("═══ 1. PDF 解析质量 ═══");
	const synthetic = await parseFile(SYNTHETIC, "");
	console.log(`合成测试 PDF: ${synthetic.pages} 页, ${synthetic.paras.length} 段, ${synthetic.chars} 字符`);
	console.log(`  前2段: ${synthetic.paras.slice(0, 2).map((p) => `[页${p.page}]${p.text.slice(0, 30)}`).join(" | ")}`);

	const moutai = await parseFile(MOUTAI, "");
	console.log(`茅台财报: ${moutai.pages} 页, ${moutai.paras.length} 段, ${moutai.chars} 字符, ${moutai.chapterCount} 章`);
	const sampled = moutai.paras.slice(0, 3).map((p) => `[页${p.page}]${p.text.slice(0, 24)}`);
	console.log(`  前3段: ${sampled.join(" | ")}`);
	// 验证页码分布覆盖全文档
	const pages = new Set(moutai.paras.map((p) => p.page));
	console.log(`  页码覆盖: ${Math.min(...pages)}–${Math.max(...pages)}（共 ${pages.size} 个不同页码）`);

	console.log("\n═══ 2. 入库 ═══");
	const tmpDir = mkdtempSync(join(tmpdir(), "dsh-docintel-e2e-"));
	const store = openStore(join(tmpDir, "kb.sqlite"));
	for (const parsed of [synthetic, moutai]) {
		const result = store.addDocument({
			path: parsed.name,
			name: parsed.name,
			kind: parsed.kind,
			sha256: sha256Of(parsed.name === synthetic.name ? SYNTHETIC : MOUTAI),
			pages: parsed.pages,
			chars: parsed.chars,
			chunks: chunkParas(parsed.paras)
		});
		console.log(`${parsed.name}: ${result.status} (${result.chunks} 块)`);
	}

	console.log("\n═══ 3. 中文检索（双通道）═══");
	const queries = ["现金流", "毛利率", "万科", "茅台", "不良贷款", "应收账款"];
	for (const q of queries) {
		const rows = store.search(q, 3);
		if (rows.length === 0) {
			console.log(`「${q}」: ❌ 零命中`);
			continue;
		}
		const hits = rows.map((r) => `${r.name.split(".")[0]}·${r.page ? `页${r.page}` : ""}(${r.channel})`).join(", ");
		console.log(`「${q}」: ✅ ${rows.length} 条 — ${hits}`);
		console.log(`    例: ${rows[0].snippet.slice(0, 60)}`);
	}

	console.log("\n═══ 4. 状态与清理 ═══");
	console.log(`文档数: ${store.listDocuments().length}`);
	store.close();
	rmSync(tmpDir, { recursive: true, force: true });
	console.log("临时库已清理 ✅");
}

main().catch((error) => {
	console.error("e2e 失败:", error);
	process.exit(1);
});
