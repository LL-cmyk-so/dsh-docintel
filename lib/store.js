/**
 * dsh-docintel — store layer.
 *
 * A local-first, open-format knowledge base backed by SQLite FTS5 (via
 * node:sqlite, built into Node 24 — zero native deps). Everything a document
 * becomes lives in two tables:
 *
 *   docs   — one row per added document (path, sha256, kind, page count, …)
 *   chunks — FTS5 (trigram tokenizer) rows, one per ~2k-char chunk, carrying
 *            the locator metadata the agent needs to cite precisely:
 *            { doc_id, page, para, section, chunk_index }
 *
 * The file is a plain SQLite database at <workspace>/.dsh-docintel/kb.sqlite,
 * deliberately NOT a private format: book-distiller / financial-report or any
 * other plugin can open it and SELECT directly (that is the "open format"
 * design decision — the knowledge base is a shared asset, not a silo).
 *
 * Chinese retrieval uses a dual channel because FTS5's trigram tokenizer has
 * no index entries for 1–2 character queries ("万科", "茅台" match nothing):
 *   - channel 1: FTS5 MATCH + bm25() ranking for queries containing ≥3-char tokens
 *   - channel 2: SQL LIKE fallback (parameterized, escaped) for ≤2-char tokens
 * Both are deterministic, offline and explainable — no embeddings, no service.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, sep } from "node:path";

const DEFAULT_CHUNK_CHARS = 2000;

/** SQLite LIKE escape for `%`, `_` and the escape char itself. */
function escapeLike(input) {
	return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Count "meaningful" characters (CJK + alnum) in a token. */
function meaningfulLen(token) {
	let n = 0;
	for (const ch of token) {
		if (/[\u3400-\u9fff\uf900-\ufaff]/.test(ch)) n += 1;
		else if (/[A-Za-z0-9]/.test(ch)) n += 1;
	}
	return n;
}

/** Split a raw query into searchable tokens (whitespace separated). */
function tokenizeQuery(query) {
	return String(query ?? "")
		.split(/\s+/)
		.map((t) => t.trim())
		.filter((t) => t.length > 0);
}

/** Build a highlighted snippet around the first hit of any token. */
export function makeSnippet(body, tokens, windowChars = 60) {
	const text = String(body ?? "");
	const hits = [];
	for (const token of tokens) {
		let idx = -1;
		let from = 0;
		// find first occurrence (case-insensitive for latin)
		while (true) {
			idx = text.toLowerCase().indexOf(token.toLowerCase(), from);
			if (idx < 0) break;
			// avoid matching inside an existing hit window
			if (hits.every((h) => !(idx >= h.start && idx < h.end))) break;
			from = idx + 1;
		}
		if (idx >= 0) hits.push({ start: idx, end: idx + token.length });
	}
	if (hits.length === 0) {
		return text.length > windowChars * 2
			? `${text.slice(0, windowChars * 2)}…`
			: text;
	}
	hits.sort((a, b) => a.start - b.start);
	const first = hits[0];
	const start = Math.max(0, first.start - windowChars);
	const end = Math.min(text.length, hits[hits.length - 1].end + windowChars);
	let out = text.slice(start, end);
	if (start > 0) out = `…${out}`;
	if (end < text.length) out = `${out}…`;
	// wrap each hit with markdown bold (agent-visible highlight)
	for (const h of hits) {
		const hlStart = Math.max(start, h.start) - start;
		const hlEnd = Math.min(end, h.end) - start;
		out = `${out.slice(0, hlStart)}**${out.slice(hlStart, hlEnd)}**${out.slice(hlEnd)}`;
	}
	return out;
}

/** Open (create if needed) the knowledge base at dbPath and return a store. */
export function openStore(dbPath, opts = {}) {
	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new DatabaseSync(dbPath);
	db.exec(`
		PRAGMA journal_mode = WAL;
		CREATE TABLE IF NOT EXISTS docs (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			path       TEXT NOT NULL,
			name       TEXT NOT NULL,
			kind       TEXT NOT NULL,
			sha256     TEXT NOT NULL,
			pages      INTEGER,
			chars      INTEGER NOT NULL,
			added_at   INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_docs_path ON docs(path);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_docs_sha  ON docs(sha256);
		CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
			body,
			doc_id      UNINDEXED,
			page        UNINDEXED,
			para        UNINDEXED,
			section     UNINDEXED,
			chunk_index UNINDEXED,
			tokenize = 'trigram'
		);
	`);
	return new DocIntelStore(db, dbPath, opts);
}

export class DocIntelStore {
	constructor(db, dbPath, opts = {}) {
		this.db = db;
		this._dbPath = dbPath;
		this.chunkChars = opts.chunkChars ?? DEFAULT_CHUNK_CHARS;
	}

	close() {
		try {
			this.db.close();
		} catch { /* already closed */ }
	}

	/**
	 * Add (or refresh) one parsed document.
	 * @param {object} doc - { path, name, kind, sha256, pages, chars, chunks }
	 *   chunks: [{ body, page, para, section }] (already chunked by caller)
	 * @returns {{status:'added'|'updated'|'skipped', docId:number, chunks:number, reason?:string}}
	 */
	addDocument(doc) {
		const now = Date.now();
		const existingByPath = this.db
			.prepare("SELECT id FROM docs WHERE path = ?")
			.get(doc.path);
		const existingBySha = this.db
			.prepare("SELECT id FROM docs WHERE sha256 = ?")
			.get(doc.sha256);

		// Same content already indexed under another path → skip (dedupe).
		if (existingBySha && (!existingByPath || existingBySha.id !== existingByPath.id)) {
			return { status: "skipped", docId: existingBySha.id, chunks: 0, reason: "duplicate content already indexed" };
		}

		let docId;
		if (existingByPath) {
			docId = existingByPath.id;
			// Same path, unchanged content → nothing to write.
			if (existingBySha) {
				return { status: "skipped", docId, chunks: 0, reason: "unchanged content" };
			}
			this.db.prepare("DELETE FROM chunks WHERE doc_id = ?").run(docId);
			this.db
				.prepare("UPDATE docs SET name=?, kind=?, sha256=?, pages=?, chars=?, updated_at=? WHERE id=?")
				.run(doc.name, doc.kind, doc.sha256, doc.pages ?? null, doc.chars, now, docId);
		} else {
			const info = this.db
				.prepare("INSERT INTO docs (path, name, kind, sha256, pages, chars, added_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
				.run(doc.path, doc.name, doc.kind, doc.sha256, doc.pages ?? null, doc.chars, now, now);
			docId = Number(info.lastInsertRowid);
		}

		const insertChunk = this.db.prepare(
			"INSERT INTO chunks (body, doc_id, page, para, section, chunk_index) VALUES (?,?,?,?,?,?)"
		);
		const tx = this.db.exec.bind(this.db);
		tx("BEGIN");
		try {
			doc.chunks.forEach((c, i) => {
				insertChunk.run(c.body, docId, c.page ?? null, c.para ?? null, c.section ?? null, i);
			});
			tx("COMMIT");
		} catch (error) {
			tx("ROLLBACK");
			throw error;
		}
		return { status: existingByPath ? "updated" : "added", docId, chunks: doc.chunks.length };
	}

	/**
	 * Dual-channel search. Returns up to k chunks, each with its locator and a
	 * highlighted snippet. Rows from the FTS5 channel rank first (bm25), LIKE
	 * results fill the remainder.
	 * @returns {Array<{docId, name, path, page, para, section, snippet, score}>}
	 */
	search(query, k = 5) {
		const limit = Math.max(1, Math.min(10, Number(k) || 5));
		const tokens = tokenizeQuery(query);
		if (tokens.length === 0) return [];
		const results = new Map();

		const push = (row, channel) => {
			const key = `${row.doc_id}:${row.chunk_index}`;
			if (results.has(key)) return;
			results.set(key, {
				docId: row.doc_id,
				page: row.page,
				para: row.para,
				section: row.section,
				body: row.body,
				channel
			});
		};

		// Channel 1: FTS5 trigram MATCH for tokens with ≥3 meaningful chars.
		const longTokens = tokens.filter((t) => meaningfulLen(t) >= 3);
		if (longTokens.length > 0) {
			const matchQuery = longTokens
				.map((t) => `"${t.replace(/"/g, '""')}"`)
				.join(" ");
			try {
				const rows = this.db
					.prepare(
						`SELECT body, doc_id, page, para, section, chunk_index, bm25(chunks) AS score
						 FROM chunks WHERE chunks MATCH ? ORDER BY bm25(chunks) LIMIT ?`
					)
					.all(matchQuery, limit * 2);
				for (const row of rows) push(row, "fts");
			} catch (error) {
				// Malformed MATCH (e.g. stray punctuation) — fall through to LIKE.
				// eslint-disable-next-line no-console
				console.warn(`[dsh-docintel] fts search failed (${error.message}); using LIKE fallback`);
			}
		}

		// Channel 2: LIKE fallback for short tokens (1–2 chars) or when the FTS
		// channel produced nothing. Parameterized + escaped, so safe.
		const shortTokens = tokens.filter((t) => meaningfulLen(t) < 3);
		if (results.size === 0 && shortTokens.length > 0) {
			const like = `%${escapeLike(shortTokens[0])}%`;
			const rows = this.db
				.prepare(
					`SELECT body, doc_id, page, para, section, chunk_index
					 FROM chunks WHERE body LIKE ? ESCAPE '\\' ORDER BY doc_id, chunk_index LIMIT ?`
				)
				.all(like, limit * 2);
			for (const row of rows) push(row, "like");
		}
		// When the query is all short tokens, LIKE must be the only channel —
		// the condition above covers it. When FTS produced nothing and there
		// are no short tokens (edge: empty after filtering), nothing to do.

		const docs = this.db.prepare("SELECT id, name, path FROM docs").all();
		const docById = new Map(docs.map((d) => [d.id, d]));

		const out = [];
		for (const [key, r] of results) {
			const doc = docById.get(r.docId);
			if (!doc) continue;
			out.push({
				docId: r.docId,
				name: doc.name,
				path: doc.path,
				page: r.page,
				para: r.para,
				section: r.section,
				snippet: makeSnippet(r.body, tokens),
				channel: r.channel
			});
		}
		return out.slice(0, limit);
	}

	/** List indexed documents (for doc_status). */
	listDocuments() {
		return this.db
			.prepare(
				`SELECT d.id, d.name, d.path, d.kind, d.pages, d.chars, d.updated_at,
				        (SELECT COUNT(*) FROM chunks c WHERE c.doc_id = d.id) AS chunks
				 FROM docs d ORDER BY d.updated_at DESC`
			)
			.all();
	}

	/** Resolve the store's dbPath (for tool output / debugging). */
	get dbPath() {
		return this._dbPath;
	}

	/**
	 * Remove a document (its chunks + docs row) by id. Returns whether an
	 * uploaded file copy should be deleted too (path under .../uploads/).
	 * @param {number} id - docs.id
	 * @returns {{removed:boolean, name?:string, path?:string, uploadsFile?:string|null}}
	 */
	removeDocument(id) {
		const doc = this.db.prepare("SELECT id, name, path FROM docs WHERE id = ?").get(id);
		if (!doc) return { removed: false };
		const tx = this.db.exec.bind(this.db);
		tx("BEGIN");
		try {
			this.db.prepare("DELETE FROM chunks WHERE doc_id = ?").run(id);
			this.db.prepare("DELETE FROM docs WHERE id = ?").run(id);
			tx("COMMIT");
		} catch (error) {
			tx("ROLLBACK");
			throw error;
		}
		const uploadsFile = doc.path.includes(`${sep}uploads${sep}`) || doc.path.includes("/uploads/") ? doc.path : null;
		return { removed: true, name: doc.name, path: doc.path, uploadsFile };
	}
}
