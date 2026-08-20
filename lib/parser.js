/**
 * dsh-docintel — parser layer.
 *
 * PDF: pdfjs-dist, page-by-page extraction that keeps real page numbers
 * (verified against PyMuPDF at ~99% character parity on real annual reports),
 * bookmark-based chapter splitting (port of book-distiller's pdf_parser.py),
 * scanned-PDF detection (same <30 chars/page threshold) and a light
 * header/footer repeater filter.
 *
 * Text: markdown/txt/csv/json fast path with heading→section tracking.
 *
 * Output shape (both): { kind, name, pages, chars, paras }
 *   paras: [{ text, page?, para?, section? }]
 */

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

const SCANNED_THRESHOLD = 30; // chars/page below this ⇒ scanned/imagery PDF
const HEADER_FOOTER_RATIO = 0.3; // block repeated on ≥30% of pages ⇒ boilerplate

const SUPPORTED_KINDS = {
	".pdf": "pdf",
	".md": "md",
	".markdown": "md",
	".txt": "txt",
	".text": "txt",
	".csv": "csv",
	".json": "json"
};

/** True when a char is CJK (used for space-free line joining). */
function isCjk(ch) {
	return /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/.test(ch);
}

/** Join two line fragments without corrupting CJK (no space) or latin (space). */
function joinLines(a, b) {
	if (!a) return b;
	if (!b) return a;
	const last = a[a.length - 1];
	const first = b[0];
	return isCjk(last) || isCjk(first) ? a + b : `${a} ${b}`;
}

/** Cluster pdfjs text items into visual paragraphs with real page numbers. */
function clusterParagraphs(items) {
	// 1) group items into rows by y coordinate (3px tolerance)
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
		row.parts.push({ x, str, eol: !!it.hasEOL });
	}
	// 2) sort rows top→bottom, parts left→right
	rows.sort((a, b) => a.y - b.y);
	for (const r of rows) r.parts.sort((a, b) => a.x - b.x);
	// 3) merge rows into paragraphs; a row whose last part hasEOL ends the paragraph
	const paragraphs = [];
	let current = "";
	for (const r of rows) {
		const line = r.parts.map((p) => p.str).join(" ");
		const breaks = r.parts.some((p) => p.eol);
		current = joinLines(current, line);
		if (breaks || r === rows[rows.length - 1]) {
			const t = current.replace(/\s+/g, " ").trim();
			if (t.length >= 2) paragraphs.push(t);
			current = "";
		}
	}
	return paragraphs;
}

/** Resolve an outline item's destination to a 1-based page number. */
async function destPage(pdf, item) {
	try {
		const dest = item.dest;
		if (Array.isArray(dest)) {
			return (await pdf.getPageIndex(dest[0])) + 1;
		}
		if (typeof dest === "string") {
			const resolved = await pdf.getDestination(dest);
			if (resolved) return (await pdf.getPageIndex(resolved[0])) + 1;
		}
	} catch { /* unresolved dest */ }
	return null;
}

/**
 * Build the page→section map from the PDF outline (port of pdf_parser.py's
 * bookmark chapter split). Returns { chapters } where each chapter carries
 * its page range; the caller assigns section per paragraph.
 * @returns {Array<{title:string, pageFrom:number, pageTo:number}>}
 */
async function buildChapters(pdf) {
	let outline = [];
	try {
		outline = (await pdf.getOutline()) ?? [];
	} catch { /* no outline */ }
	if (outline.length === 0) {
		return { chapters: [{ title: "（未命名）", pageFrom: 1, pageTo: pdf.numPages }], level2: [] };
	}
	const level1 = [];
	const level2 = [];
	for (const item of outline) {
		const page = await destPage(pdf, item);
		if (page === null) continue;
		level1.push({ title: item.title?.trim(), page });
		for (const sub of item.items ?? []) {
			const subPage = await destPage(pdf, sub);
			if (subPage !== null) {
				level2.push({ title: sub.title?.trim(), page: subPage });
			}
		}
	}
	if (level1.length === 0) {
		return { chapters: [{ title: "（未命名）", pageFrom: 1, pageTo: pdf.numPages }], level2: [] };
	}
	level1.sort((a, b) => a.page - b.page);
	level2.sort((a, b) => a.page - b.page);
	const chapters = level1.map((c, i) => ({
		title: c.title || `（未命名 ${i + 1}）`,
		pageFrom: c.page,
		pageTo: i + 1 < level1.length ? level1[i + 1].page - 1 : pdf.numPages
	}));
	// pages before the first bookmark → an unnamed front chapter
	if (chapters[0].pageFrom > 1) {
		chapters.unshift({ title: "（未命名 0）", pageFrom: 1, pageTo: chapters[0].pageFrom - 1 });
	}
	return { chapters, level2 };
}

/** Parse a PDF into chapter-structured paragraphs with real page numbers. */
export async function parsePdf(path) {
	const data = new Uint8Array(await readFile(path));
	const loadingTask = getDocument({ data, disableWorker: true });
	const pdf = await loadingTask.promise;
	try {
		const { chapters, level2 } = await buildChapters(pdf);
		const numPages = pdf.numPages;

		// chapter → page range lookup
		const chapterByPage = new Map();
		for (const ch of chapters) {
			for (let p = ch.pageFrom; p <= ch.pageTo; p++) chapterByPage.set(p, ch.title);
		}
		// level-2 sections: page → section title (last wins, like pdf_parser)
		const sectionByPage = new Map();
		for (const s of level2 ?? []) sectionByPage.set(s.page, s.title);

		// page-by-page extraction
		// page-by-page extraction, batched concurrently (bounded to keep large
		// PDFs' memory in check — serial pages are slow past ~200 pages)
		const perPage = [];
		const CONCURRENCY = 4;
		for (let start = 1; start <= numPages; start += CONCURRENCY) {
			const batch = [];
			for (let i = start; i < Math.min(start + CONCURRENCY, numPages + 1); i++) batch.push(i);
			const results = await Promise.all(batch.map(async (pageNo) => {
				const page = await pdf.getPage(pageNo);
				const content = await page.getTextContent();
				page.cleanup();
				return { page: pageNo, blocks: clusterParagraphs(content.items) };
			}));
			perPage.push(...results);
		}

		const totalChars = perPage.reduce((n, p) => n + p.blocks.reduce((m, b) => m + b.length, 0), 0);
		if (totalChars < numPages * SCANNED_THRESHOLD) {
			throw new Error(
				`扫描版/图片版 PDF 暂不支持（检测到几乎无文本：${numPages} 页仅 ${totalChars} 字符）。请提供文本版 PDF（v0.3 将支持 OCR）。`
			);
		}

		// header/footer repeater filter: drop blocks repeated on ≥30% of pages
		const counts = new Map();
		for (const p of perPage) {
			for (const b of p.blocks) counts.set(b, (counts.get(b) ?? 0) + 1);
		}
		const boilerplate = new Set();
		const threshold = Math.max(3, Math.floor(numPages * HEADER_FOOTER_RATIO));
		for (const [block, n] of counts) {
			if (n >= threshold && block.length >= 4) boilerplate.add(block);
		}
		// page-number boilerplate ("8 / 143") — varies per page, so the repeater
		// above can't catch it
		const PAGE_NO_RE = /^\d{1,4}\s*\/\s*\d{1,4}$/;

		const paras = [];
		for (const p of perPage) {
			const chapter = chapterByPage.get(p.page) ?? null;
			const section = sectionByPage.get(p.page) ?? null;
			for (const block of p.blocks) {
				if (boilerplate.has(block)) continue;
				if (PAGE_NO_RE.test(block)) continue;
				const sec = section ? `${chapter} > ${section}` : chapter;
				paras.push({ text: block, page: p.page, section: sec });
			}
		}

		return {
			kind: "pdf",
			pages: numPages,
			chars: paras.reduce((n, p) => n + p.text.length, 0),
			paras,
			chapterCount: chapters.length
		};
	} finally {
		try { await loadingTask.destroy(); } catch { /* already closed */ }
	}
}

/** Parse markdown: heading→section path tracking, blank-line paragraph split. */
export function parseMarkdown(text) {
	const lines = String(text ?? "").split(/\r?\n/);
	const paras = [];
	const sectionStack = [];
	let paraNo = 0;
	let buf = [];
	const flush = () => {
		const t = buf.join("\n").trim();
		if (t) {
			paraNo += 1;
			paras.push({ text: t, para: paraNo, section: sectionStack.length ? sectionStack.join(" > ") : null });
		}
		buf = [];
	};
	for (const raw of lines) {
		const line = raw.trim();
		const h = line.match(/^(#{1,6})\s+(.+)$/);
		if (h) {
			flush();
			const level = h[1].length;
			const title = h[2].trim();
			sectionStack.length = level - 1;
			sectionStack[level - 1] = title;
			continue;
		}
		if (line === "") {
			flush();
			continue;
		}
		buf.push(line);
	}
	flush();
	return paras;
}

/** Parse a plain text file: blank-line paragraphs, no sections. */
export function parsePlainText(text) {
	const paras = [];
	let paraNo = 0;
	for (const block of String(text ?? "").split(/\n{2,}/)) {
		const t = block.replace(/\s+/g, " ").trim();
		if (t.length >= 2) {
			paraNo += 1;
			paras.push({ text: t, para: paraNo, section: null });
		}
	}
	return paras;
}

/** Parse any supported file into { kind, name, pages, chars, paras }. */
export async function parseFile(path, fileText) {
	const ext = extname(path).toLowerCase();
	const kind = SUPPORTED_KINDS[ext];
	if (!kind) {
		throw new Error(`不支持的文件类型 ${ext || "(无扩展名)"}。支持: ${Object.keys(SUPPORTED_KINDS).join(", ")}`);
	}
	const name = basename(path);
	if (kind === "pdf") {
		const result = await parsePdf(path);
		return { ...result, name };
	}
	if (kind === "md") {
		const paras = parseMarkdown(fileText);
		return { kind, name, pages: null, chars: fileText.length, paras };
	}
	if (kind === "json") {
		let pretty = fileText;
		try {
			pretty = JSON.stringify(JSON.parse(fileText), null, 2);
		} catch { /* keep raw */ }
		return { kind, name, pages: null, chars: pretty.length, paras: parsePlainText(pretty) };
	}
	// txt / csv
	return { kind, name, pages: null, chars: fileText.length, paras: parsePlainText(fileText) };
}

/** Whether a file path is supported by docintel. */
export function isSupportedPath(path) {
	return SUPPORTED_KINDS[extname(path).toLowerCase()] !== undefined;
}
