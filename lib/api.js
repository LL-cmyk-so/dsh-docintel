/**
 * dsh-docintel — v0.2 host API routes.
 *
 * Loopback-only same-origin routes the web drawer calls:
 *   GET  /api/docintel/docs   → listDocuments()
 *   GET  /api/docintel/search → store.search(query, k)
 *   POST /api/docintel/upload → accept { name, base64 } → save under
 *                               <workspace>/.dsh-docintel/uploads/ → index.
 *
 * Upload uses base64 JSON on purpose: no multipart parser, no extra
 * dependency — the simplest possible wire format (personal docs are a few MB).
 */

const API = {
	docs: "/api/docintel/docs",
	search: "/api/docintel/search",
	upload: "/api/docintel/upload",
	delete: "/api/docintel/delete"
};

function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(payload)
	});
	res.end(payload);
}

function isLoopbackRequest(req) {
	const address = req.socket?.remoteAddress ?? "";
	return address === "::1"
		|| address === "::ffff:127.0.0.1"
		|| address === "127.0.0.1"
		|| address === "localhost"
		|| address.startsWith("::ffff:127.");
}

function guard(req, res, method) {
	if (!isLoopbackRequest(req)) {
		writeJson(res, 403, { error: "forbidden: loopback-only" });
		return false;
	}
	if ((req.method ?? "GET") !== method) {
		writeJson(res, 405, { error: `method not allowed: ${req.method}` });
		return false;
	}
	return true;
}

/** Read a JSON request body (small, personal-doc scale). */
function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > 64 * 1024 * 1024) {
				reject(new Error("body too large (limit 64MB)"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch (error) {
				reject(new Error(`invalid JSON body: ${error.message}`));
			}
		});
		req.on("error", reject);
	});
}

/**
 * Build the route table for the docintel web panel.
 * @param {object} ctx - cordis context (for logging).
 * @param {object} store - DocIntelStore instance.
 * @param {object} config - resolved plugin config.
 * @param {string} workspaceRoot - resolved workspace root.
 * @param {Function} indexOneFile - from index.js (parse + store one file).
 */
export function makeDocintelRoutes(ctx, store, config, workspaceRoot, indexOneFile) {
	return [
		{
			kind: "exact",
			path: API.docs,
			handler: async (req, res) => {
				if (!guard(req, res, "GET")) return;
				const docs = store.listDocuments();
				writeJson(res, 200, { docs, count: docs.length, dbPath: store.dbPath });
			}
		},
		{
			kind: "exact",
			path: API.search,
			handler: async (req, res) => {
				if (!guard(req, res, "GET")) return;
				const url = new URL(req.url ?? "/", "http://localhost");
				const query = (url.searchParams.get("q") ?? "").trim();
				if (!query) {
					writeJson(res, 400, { error: "missing q parameter" });
					return;
				}
				const k = Math.max(1, Math.min(10, Number(url.searchParams.get("k")) || 5));
				const results = store.search(query, k).map((r) => ({
					name: r.name,
					page: r.page,
					para: r.para,
					section: r.section,
					snippet: r.snippet
				}));
				writeJson(res, 200, { query, count: results.length, results });
			}
		},
		{
			kind: "exact",
			path: API.upload,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				let body;
				try {
					body = await readJsonBody(req);
				} catch (error) {
					writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
					return;
				}
				const name = String(body?.name ?? "").trim();
				const base64 = String(body?.base64 ?? "");
				if (!name || !base64) {
					writeJson(res, 400, { error: "missing name or base64" });
					return;
				}
				const bytes = Buffer.from(base64, "base64");
				if (bytes.length === 0 || bytes.length > 64 * 1024 * 1024) {
					writeJson(res, 400, { error: "empty or oversized upload (limit 64MB)" });
					return;
				}
				try {
					// Save under the knowledge dir (inside the workspace, so the
					// workspace-scope guard in indexOneFile accepts the path).
					const { join } = await import("node:path");
					const { mkdir, writeFile } = await import("node:fs/promises");
					const uploadDir = join(workspaceRoot, config.storageDir, "uploads");
					await mkdir(uploadDir, { recursive: true });
					// sanitize the file name (no path separators / traversal)
					const safe = name.replace(/[/\\]/g, "_");
					const filePath = join(uploadDir, safe);
					await writeFile(filePath, bytes);
					const outcome = await indexOneFile(filePath, store, config.chunkChars, workspaceRoot);
					writeJson(res, 200, {
						ok: true,
						name: safe,
						status: outcome.skipped ? "skipped" : outcome.line.includes("已更新") ? "updated" : "added",
						detail: outcome.line
					});
				} catch (error) {
					ctx.logger?.warn?.("[dsh-docintel] upload failed: %s", error instanceof Error ? error.message : String(error));
					writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
				}
			}
		},
		{
			kind: "exact",
			path: API.delete,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				let body;
				try {
					body = await readJsonBody(req);
				} catch (error) {
					writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
					return;
				}
				const id = Number(body?.id);
				if (!Number.isInteger(id) || id <= 0) {
					writeJson(res, 400, { error: "invalid id" });
					return;
				}
				try {
					const result = store.removeDocument(id);
					if (result.removed && result.uploadsFile) {
						const { unlink } = await import("node:fs/promises");
						await unlink(result.uploadsFile).catch(() => { /* already gone */ });
					}
					writeJson(res, 200, { ok: true, removed: result.removed, name: result.name ?? null });
				} catch (error) {
					ctx.logger?.warn?.("[dsh-docintel] delete failed: %s", error instanceof Error ? error.message : String(error));
					writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
				}
			}
		}
	];
}

export { API };
