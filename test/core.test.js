import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore, makeSnippet } from "../lib/store.js";
import { chunkParas, chunkText } from "../lib/chunker.js";
import { parseMarkdown, parsePlainText, isSupportedPath } from "../lib/parser.js";

function sampleDocs() {
	return [
		{
			path: "/ws/万科A2025年年度报告.PDF",
			name: "万科A2025年年度报告.PDF",
			kind: "pdf",
			sha256: "a".repeat(64),
			pages: 143,
			chars: 1000,
			chunks: [
				{ body: "万科2025年报显示现金流紧张，经营现金流为负。", page: 42, section: "第五节 重要事项" },
				{ body: "公司有息负债规模下降，流动性风险可控。", page: 43, section: "第五节 重要事项" },
				{ body: "贵州茅台毛利率高达91%，现金流充裕。", page: 8, section: "第三节 管理层讨论与分析" }
			]
		},
		{
			path: "/ws/notes.md",
			name: "notes.md",
			kind: "md",
			sha256: "b".repeat(64),
			pages: null,
			chars: 300,
			chunks: [
				{ body: "华友钴业新能源材料业务增长，应收账款增加。", para: 1, section: "行业 > 新能源" }
			]
		}
	];
}

test("add + search: 3字词走 FTS trigram 通道", () => {
	const store = openStore(":memory:");
	for (const doc of sampleDocs()) store.addDocument(doc);
	const rows = store.search("现金流", 5);
	assert.ok(rows.length >= 1, "应命中现金流");
	assert.equal(rows[0].name, "万科A2025年年度报告.PDF");
	assert.equal(rows[0].page, 42);
	assert.ok(rows[0].snippet.includes("**现金流**"), "snippet 应高亮命中词");
	store.close();
});

test("add + search: 2字词走 LIKE 兜底通道（trigram 盲区）", () => {
	const store = openStore(":memory:");
	for (const doc of sampleDocs()) store.addDocument(doc);
	const rows = store.search("万科", 5);
	assert.ok(rows.length >= 1, "2字词万科必须命中");
	assert.equal(rows[0].name, "万科A2025年年度报告.PDF");
	assert.equal(rows[0].page, 42);
	store.close();
});

test("add + search: 2字词在不同文档（茅台）", () => {
	const store = openStore(":memory:");
	for (const doc of sampleDocs()) store.addDocument(doc);
	const rows = store.search("茅台", 5);
	assert.equal(rows[0].name, "万科A2025年年度报告.PDF");
	assert.equal(rows[0].page, 8);
	store.close();
});

test("search: 多词查询命中多条", () => {
	const store = openStore(":memory:");
	for (const doc of sampleDocs()) store.addDocument(doc);
	const rows = store.search("万科 现金流", 5);
	assert.ok(rows.length >= 1);
	assert.equal(rows[0].page, 42);
	store.close();
});

test("search: 无命中返回空数组", () => {
	const store = openStore(":memory:");
	for (const doc of sampleDocs()) store.addDocument(doc);
	assert.equal(store.search("不存在的词xyz", 5).length, 0);
	store.close();
});

test("search: k 上限 10，空查询返回空", () => {
	const store = openStore(":memory:");
	for (const doc of sampleDocs()) store.addDocument(doc);
	assert.equal(store.search("现金流", 999).length <= 10, true);
	assert.equal(store.search("   ", 5).length, 0);
	store.close();
});

test("dedupe: 同 sha 不同路径 → skipped", () => {
	const store = openStore(":memory:");
	const [d1] = sampleDocs();
	store.addDocument(d1);
	const dup = { ...d1, path: "/ws/copy.pdf" };
	const result = store.addDocument(dup);
	assert.equal(result.status, "skipped");
	assert.equal(store.listDocuments().length, 1);
	store.close();
});

test("update: 同路径内容变化 → updated 且 chunks 替换", () => {
	const store = openStore(":memory:");
	const [d1] = sampleDocs();
	store.addDocument(d1);
	const changed = {
		...d1,
		sha256: "c".repeat(64),
		chunks: [{ body: "万科最新现金流转正。", page: 50, section: "第五节 重要事项" }]
	};
	const result = store.addDocument(changed);
	assert.equal(result.status, "updated");
	const rows = store.search("转正", 5);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].page, 50);
	// 旧内容不再可检索
	assert.equal(store.search("经营现金流为负", 5).length, 0);
	store.close();
});

test("listDocuments 返回块数", () => {
	const store = openStore(":memory:");
	for (const doc of sampleDocs()) store.addDocument(doc);
	const docs = store.listDocuments();
	assert.equal(docs.length, 2);
	assert.equal(docs.find((d) => d.name.includes("万科")).chunks, 3);
	store.close();
});

test("removeDocument: 删除索引+块，幂等", () => {
	const store = openStore(":memory:");
	const [d1, d2] = sampleDocs();
	store.addDocument(d1);
	store.addDocument(d2);
	const vanke = store.listDocuments().find((d) => d.name.includes("万科"));
	const result = store.removeDocument(vanke.id);
	assert.equal(result.removed, true);
	assert.equal(result.name, "万科A2025年年度报告.PDF");
	// 索引和块都没了
	assert.equal(store.listDocuments().length, 1);
	assert.equal(store.search("现金流", 5).length, 0);
	// 幂等
	assert.equal(store.removeDocument(vanke.id).removed, false);
	store.close();
});

test("chunkParas: 按预算分块、保持段落完整、定位取首段", () => {
	const paras = [];
	for (let i = 1; i <= 30; i++) {
		paras.push({ text: `第${i}段：这是一段用于测试分块的中文文本内容。`, page: Math.ceil(i / 10), section: `章${i}` });
	}
	const chunks = chunkParas(paras, 100);
	assert.ok(chunks.length > 1, "应分成多块");
	for (const c of chunks) {
		assert.ok(c.page !== null);
		assert.ok(c.section !== null);
	}
	assert.equal(chunks[0].body.startsWith("第1段"), true);
});

test("chunkText: 纯文本按空行分段", () => {
	const text = "第一段内容。\n\n第二段内容。\n\n第三段内容。";
	const chunks = chunkText(text, 10);
	assert.ok(chunks.length >= 2);
	assert.equal(chunks[0].para, 1);
});

test("parseMarkdown: 标题→section 路径，段落→para", () => {
	const md = "# 第一节 公司简介\n\n这是简介内容。\n\n## 1.1 基本情况\n\n这是基本情况。\n\n这是补充。";
	const paras = parseMarkdown(md);
	assert.equal(paras.length, 3);
	assert.equal(paras[0].section, "第一节 公司简介");
	assert.equal(paras[1].section, "第一节 公司简介 > 1.1 基本情况");
	assert.equal(paras[1].para, 2);
});

test("parsePlainText: 空行分段", () => {
	const paras = parsePlainText("第一段。\n\n第二段。");
	assert.equal(paras.length, 2);
	assert.equal(paras[0].para, 1);
	assert.equal(paras[1].para, 2);
});

test("isSupportedPath", () => {
	assert.equal(isSupportedPath("a.PDF"), true);
	assert.equal(isSupportedPath("a.md"), true);
	assert.equal(isSupportedPath("a.docx"), false);
	assert.equal(isSupportedPath("a"), false);
});

test("makeSnippet: 中文命中高亮 + 截断", () => {
	const body = "贵州茅台毛利率高达91%，经营现金流充裕，资产负债率保持健康水平。";
	const snippet = makeSnippet(body, ["现金流"]);
	assert.ok(snippet.includes("**现金流**"));
});
