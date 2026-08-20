/**
 * dsh-docintel — chunker.
 *
 * Port of book-distiller's `split_blocks` philosophy: cut paragraphs into
 * bounded chunks by character budget while keeping paragraphs whole. Each
 * chunk carries its locator metadata (page / para / section) so the agent can
 * cite precisely ("据《万科2025年报》第42页…").
 *
 * Input paras: [{ text, page?, para?, section? }]
 * Output chunks: [{ body, page, para, section }]
 */

const DEFAULT_CHUNK_CHARS = 2000;

/** Merge chunks smaller than a quarter of the budget into their neighbours,
 *  so tiny fragments don't dilute retrieval quality. Locator (page/para/
 *  section) stays with the merged chunk's first block. */
function mergeSmallBlocks(blocks, chunkChars) {
	const minChars = Math.max(200, Math.floor(chunkChars / 4));
	const out = [];
	for (const block of blocks) {
		const last = out[out.length - 1];
		if (last && last.body.length < minChars && last.body.length + block.body.length <= chunkChars) {
			last.body = `${last.body}\n\n${block.body}`;
			if (last.section === null && block.section !== null) last.section = block.section;
			continue;
		}
		out.push({ ...block });
	}
	return out;
}

/**
 * Split paragraphs into chunks. A chunk's locator is taken from its first
 * paragraph (start page / start para / section path).
 * @param {Array<{text:string, page?:number, para?:number, section?:string|null}>} paras
 * @param {number} chunkChars - character budget per chunk.
 * @returns {Array<{body:string, page:number|null, para:number|null, section:string|null}>}
 */
export function chunkParas(paras, chunkChars = DEFAULT_CHUNK_CHARS) {
	const blocks = [];
	let cur = [];
	let curLen = 0;
	for (const p of paras) {
		const text = String(p.text ?? "").trim();
		if (!text) continue;
		const len = text.length;
		// Oversized single paragraph: still keep it whole (better to have one
		// long chunk than to split mid-paragraph and lose locator precision).
		if (cur.length > 0 && curLen + len > chunkChars) {
			blocks.push(cur);
			cur = [];
			curLen = 0;
		}
		cur.push(p);
		curLen += len;
	}
	if (cur.length > 0) blocks.push(cur);

	const chunks = blocks.map((block) => {
		const first = block[0];
		return {
			body: block.map((p) => p.text.trim()).join("\n\n"),
			page: first.page ?? null,
			para: first.para ?? null,
			section: first.section ?? null
		};
	});
	return mergeSmallBlocks(chunks, chunkChars);
}

/**
 * Split a big continuous text (no paragraph structure) into chunks by
 * character budget. Used for plain-text files where line-level locators are
 * meaningless; locator falls back to a line range.
 * @param {string} text
 * @param {number} chunkChars
 * @returns {Array<{body:string, para:number|null, section:null}>}
 */
export function chunkText(text, chunkChars = DEFAULT_CHUNK_CHARS) {
	const paras = String(text ?? "")
		.split(/\n{2,}/)
		.map((t) => t.trim())
		.filter((t) => t.length > 0)
		.map((t, i) => ({ text: t, para: i + 1 }));
	return chunkParas(paras, chunkChars);
}
