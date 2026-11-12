import type { Database } from "./db.js";

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

export function ensureTrigramIndex(db: Database): void {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'documents_fts_trigram'");
  if (exists.get()) return;
  db.transaction(() => {
    if (exists.get()) return;
    db.exec(`
      CREATE VIRTUAL TABLE documents_fts_trigram USING fts5(
        filepath, title, body, tokenize='trigram'
      );
      INSERT INTO documents_fts_trigram(rowid, filepath, title, body)
      SELECT d.id, d.collection || '/' || d.path, d.title, c.doc
      FROM documents d JOIN content c ON c.hash = d.hash WHERE d.active = 1;

      CREATE TRIGGER trigram_after_insert AFTER INSERT ON documents WHEN new.active = 1 BEGIN
        INSERT INTO documents_fts_trigram(rowid, filepath, title, body)
        SELECT new.id, new.collection || '/' || new.path, new.title, doc
        FROM content WHERE hash = new.hash;
      END;

      CREATE TRIGGER trigram_after_update AFTER UPDATE ON documents BEGIN
        DELETE FROM documents_fts_trigram WHERE rowid = old.id;
        INSERT INTO documents_fts_trigram(rowid, filepath, title, body)
        SELECT new.id, new.collection || '/' || new.path, new.title, doc
        FROM content WHERE hash = new.hash AND new.active = 1;
      END;

      CREATE TRIGGER trigram_after_delete AFTER DELETE ON documents BEGIN
        DELETE FROM documents_fts_trigram WHERE rowid = old.id;
      END;
    `);
  }).immediate();
}

type CjkPlan = { trigramQuery?: string; shortTerms: string[]; onlyCjk: boolean };

/**
 * qmd's normal BM25 plan still handles Latin terms, quoted phrases, and
 * exclusions. Long positive CJK runs also match against SQLite's trigram
 * tokenizer. Pure CJK terms can skip the normal BM25 plan entirely.
 */
export function planCjkSearch(query: string): CjkPlan {
  const terms = new Set<string>();
  for (const token of query.matchAll(/(?:^|\s)(-)?(?:"([^"]*)"|([^\s"]+))/gu)) {
    if (token[1]) continue;
    for (const run of (token[2] ?? token[3] ?? "").matchAll(CJK_RUN)) terms.add(run[0]);
  }
  const longTerms: string[] = [];
  const shortTerms: string[] = [];
  for (const term of terms) {
    if (Array.from(term).length >= 3) longTerms.push(term);
    else shortTerms.push(term);
  }
  return {
    trigramQuery: longTerms.length ? longTerms.map(term => `"${term}"`).join(" AND ") : undefined,
    shortTerms,
    onlyCjk: terms.size > 0 && query.replace(CJK_RUN, "").trim() === "",
  };
}

/** A word and CJK run typed together are separate terms unless quoted. */
export function separateMixedScriptTerms(query: string): string {
  return query.replace(/"[^"]*"|[^\s"]+/g, token => {
    if (token.startsWith('"') || token.startsWith("-")) return token;
    return token.replace(CJK_RUN, run => ` ${run} `).trim();
  });
}

export function literalLikeSubstring(value: string): string {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}
