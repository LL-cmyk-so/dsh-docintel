#!/usr/bin/env node
/**
 * 验证假设①：pdfjs-dist 逐页提取 PDF 文本的质量，与 PyMuPDF（book-distiller
 * 的 pdf_parser.py 基准）对比。
 *
 * 关注三点：
 *  1. 能提取多少文本（字符数）——扫描版检测阈值复用 book-distiller 的 30 字符/页
 *  2. 页码保真——每页单独提取，页码天然正确
 *  3. 块聚类质量——按 y 坐标把同一行的 spans 合并成块（PyMuPDF blocks 的模拟）
 *
 * 用法：node scripts/verify-pdfjs.mjs <file.pdf>
 */
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readFile } from "node:fs/promises";

const SCANNED_THRESHOLD = 30;

function clusterIntoBlocks(items) {
  // 把 pdfjs 的 text items（有 str + transform[x,y]）按 y 坐标聚成行块。
  // PyMuPDF 的 blocks 是"视觉块"（同一段落连续的行），这里先用"行"近似，
  // 后续 chunker 会再按段落合并。
  const rows = [];
  for (const it of items) {
    const str = (it.str ?? "").trim();
    if (!str) continue;
    const y = it.transform?.[5] ?? 0;
    const x = it.transform?.[4] ?? 0;
    let row = rows.find((r) => Math.abs(r.y - y) < 3);
    if (!row) {
      row = { y, parts: [] };
      rows.push(row);
    }
    row.parts.push({ x, str });
  }
  const blocks = rows
    .sort((a, b) => a.y - b.y)
    .map((r) => r.parts.sort((a, b) => a.x - b.x).map((p) => p.str).join(" "))
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 2);
  return blocks;
}

const data = new Uint8Array(await readFile(process.argv[2]));
const loadingTask = getDocument({ data, disableWorker: true });
const pdf = await loadingTask.promise;

const perPage = [];
for (let i = 1; i <= pdf.numPages; i++) {
  const page = await pdf.getPage(i);
  const content = await page.getTextContent();
  const blocks = clusterIntoBlocks(content.items);
  const chars = blocks.reduce((n, b) => n + b.length, 0);
  perPage.push({ page: i, chars, blocks: blocks.length });
  page.cleanup();
}

const totalChars = perPage.reduce((n, p) => n + p.chars, 0);
const sampled = perPage.slice(0, 5).map((p) => p.chars);
const scanned = totalChars < pdf.numPages * SCANNED_THRESHOLD;

console.log(`文件: ${process.argv[2]}`);
console.log(`页数: ${pdf.numPages}`);
console.log(`总字符: ${totalChars}（前5页每页字符: ${sampled.join(", ")}）`);
console.log(`扫描版判定（<${SCANNED_THRESHOLD}字符/页）: ${scanned ? "是 ⚠️" : "否 ✅"}`);

// 书签（outline）解析验证——docintel 要靠书签切章（复用 pdf_parser 逻辑）
try {
  const outline = await pdf.getOutline();
  if (outline?.length) {
    const top = outline.slice(0, 5).map(async (item) => {
      let pageNo = null;
      try {
        const dest = item.dest;
        if (Array.isArray(dest)) {
          pageNo = (await pdf.getPageIndex(dest[0])) + 1;
        } else if (typeof dest === "string") {
          const resolved = await pdf.getDestination(dest);
          if (resolved) pageNo = (await pdf.getPageIndex(resolved[0])) + 1;
        }
      } catch { /* named dest may fail */ }
      return { title: item.title, pageNo };
    });
    const topResolved = await Promise.all(top);
    console.log(`书签: ${outline.length} 个顶层条目，前5个:`, JSON.stringify(topResolved));
  } else {
    console.log("书签: 无 outline（将整本作为未命名章节，需 LLM 章节识别或整本入库）");
  }
} catch (e) {
  console.log("书签解析失败:", e.message);
}

try { await pdf.destroy(); } catch { await loadingTask.destroy(); }
