// Cloudflare D1 の API（prepare/bind/first/all/run/batch）を node:sqlite の上でまねる。テストとローカル確認用
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const plain = (row) => (row ? { ...row } : null);
const isRead = (sql) => /^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql);

export function createD1(migrationsDir) {
  const db = new DatabaseSync(':memory:');
  if (migrationsDir) {
    for (const f of fs.readdirSync(migrationsDir).filter((x) => x.endsWith('.sql')).sort()) {
      db.exec(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
    }
  }
  const sizeAfter = () => {
    const pc = db.prepare('PRAGMA page_count').get().page_count;
    const ps = db.prepare('PRAGMA page_size').get().page_size;
    return pc * ps;
  };
  const exec = (sql, args) => {
    const st = db.prepare(sql);
    if (isRead(sql)) return { results: st.all(...args).map(plain), success: true, meta: { size_after: sizeAfter() } };
    const r = st.run(...args);
    return { results: [], success: true, meta: { changes: Number(r.changes), size_after: sizeAfter() } };
  };
  const statement = (sql, args = []) => ({
    sql, args,
    bind: (...a) => {
      for (const v of a) if (v === undefined) throw new Error('D1_TYPE_ERROR: undefined bind value in ' + sql);
      return statement(sql, a);
    },
    first: async (col) => {
      const r = plain(db.prepare(sql).get(...args));
      return col ? (r ? r[col] : null) : r;
    },
    all: async () => exec(sql, args),
    run: async () => exec(sql, args)
  });
  return {
    raw: db,
    prepare: (sql) => statement(sql),
    batch: async (stmts) => {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => exec(s.sql, s.args));
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
  };
}
