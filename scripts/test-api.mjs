#!/usr/bin/env node
/**
 * v0.2 API smoke test: spin a real http server, mount the docintel routes via
 * a minimal fake webServer (same shape as ctx.webServer.register), then drive
 * docs / search / upload over HTTP exactly like the browser drawer does.
 *
 * Usage: node scripts/test-api.mjs
 */
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../lib/store.js";
import { parseFile } from "../lib/parser.js";
import { chunkParas } from "../lib/chunker.js";
import { makeDocintelRoutes } from "../lib/api.js";
import { indexOneFile } from "../lib/index.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// --- minimal webServer shim (route registration only) ---
const registered = [];
const fakeWebServer = {
	register(route) {
		registered.push(route);
		return () => {
			const i = registered.indexOf(route);
			if (i >= 0) registered.splice(i, 1);
		};
	}
};
const fakeCtx = { logger: { warn: (...a) => console.warn(...a) } };

// --- real store + routes ---
const tmpDir = mkdtempSync(join(tmpdir(), "dsh-docintel-api-"));
const wsRoot = tmpDir;
const store = openStore(join(wsRoot, ".dsh-docintel", "kb.sqlite"));
const config = { storageDir: ".dsh-docintel", chunkChars: 2000, defaultK: 5 };

// index a real PDF first (so search has data)
const testPdf = decodeURIComponent(new URL("../testdata/山木科技_2023年报_测试.pdf", import.meta.url).pathname);
await indexOneFile(testPdf, store, config.chunkChars, wsRoot);

const routes = makeDocintelRoutes(fakeCtx, store, config, wsRoot, indexOneFile);

const server = createServer((req, res) => {
	const route = routes.find((r) => r.kind === "exact" && r.path === new URL(req.url, "http://localhost").pathname);
	if (!route) {
		res.writeHead(404).end("not found");
		return;
	}
	route.handler(req, res);
});

const PORT = 18923;
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

const get = async (path) => {
	const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
	return { status: res.status, body: await res.json() };
};
const post = async (path, body) => {
	const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body)
	});
	return { status: res.status, body: await res.json() };
};

let failures = 0;
const check = (name, cond, detail) => {
	if (cond) console.log(`✅ ${name}`);
	else { failures++; console.log(`❌ ${name} ${detail ?? ""}`); }
};

try {
	// 1. docs
	const docs = await get("/api/docintel/docs");
	check("GET /docs 返回文档", docs.status === 200 && docs.body.count === 1, JSON.stringify(docs));

	// 2. search
	const search = await get("/api/docintel/search?q=毛利率&k=5");
	check("GET /search 命中毛利率", search.status === 200 && search.body.count >= 1, JSON.stringify(search.body));
	check("search 结果带页码", search.body.results[0]?.page !== undefined, JSON.stringify(search.body.results?.[0]));

	// 3. search 缺 q
	const noq = await get("/api/docintel/search");
	check("GET /search 缺 q 返回 400", noq.status === 400);

	// 4. upload（base64，模拟浏览器 FileReader）
	const name = "上传测试.txt";
	const content = "这是一段通过浏览器上传的测试文档内容，包含关键词现金流。\n\n第二段，毛利率相关信息。";
	const up = await post("/api/docintel/upload", {
		name,
		base64: Buffer.from(content, "utf8").toString("base64")
	});
	check("POST /upload 入库成功", up.status === 200 && up.body.ok === true, JSON.stringify(up.body));

	// 5. upload 后能搜到
	const search2 = await get("/api/docintel/search?q=现金流&k=5");
	check("upload 后可检索", search2.body.results.some((r) => r.name === name), JSON.stringify(search2.body));

	// 6. 重复 upload → skipped
	const up2 = await post("/api/docintel/upload", {
		name,
		base64: Buffer.from(content, "utf8").toString("base64")
	});
	check("重复 upload 跳过", up2.body.status === "skipped", JSON.stringify(up2.body));

	// 7. 目录穿越文件名被清洗（不写入库外；解析失败返回错误也算通过）
	const evil = await post("/api/docintel/upload", {
		name: "../../evil.pdf",
		base64: Buffer.from("x", "utf8").toString("base64")
	});
	check("恶意文件名被阻止（不成功入库）", !(evil.status === 200 && evil.body.ok === true), JSON.stringify(evil));

	// 8. 文档数增长
	const docs2 = await get("/api/docintel/docs");
	check("文档数 = 2", docs2.body.count === 2, JSON.stringify(docs2.body));

	// 9. 删除（两段式确认由 UI 负责，API 是幂等单次调用）
	const target = docs2.body.docs.find((d) => d.name === "上传测试.txt");
	check("找到待删文档", target !== undefined);
	const del = await post("/api/docintel/delete", { id: target.id });
	check("删除成功", del.status === 200 && del.body.removed === true, JSON.stringify(del.body));
	const afterDel = await get("/api/docintel/docs");
	check("删除后文档数 = 1", afterDel.body.count === 1, JSON.stringify(afterDel.body));
	const delAgain = await post("/api/docintel/delete", { id: target.id });
	check("重复删除幂等（removed=false）", delAgain.status === 200 && delAgain.body.removed === false, JSON.stringify(delAgain.body));
	const delBad = await post("/api/docintel/delete", { id: "abc" });
	check("非法 id 返回 400", delBad.status === 400);

	// 10. 删除后检索不到
	const search3 = await get("/api/docintel/search?q=上传测试&k=5");
	check("删除后不可检索", !search3.body.results.some((r) => r.name === "上传测试.txt"), JSON.stringify(search3.body));
} finally {
	server.close();
	store.close();
	rmSync(tmpDir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAPI 测试全部通过 ✅" : `\n${failures} 个失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
