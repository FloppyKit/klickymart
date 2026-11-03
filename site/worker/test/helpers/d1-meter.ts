/** GO-KM-D1-SCANS §1: measure what one request costs in D1 reads.
 *
 * Wraps the D1 binding so every statement that actually runs is counted, and sums the `meta.rows_read` D1 reports for the
 * result (that field is part of every D1 query result: all/first/run/raw and batch). The numbers are what Cloudflare bills
 * rows read for, so a repeat hit that reads 0 rows really did not touch the database.
 *
 * Test-only: nothing in worker/src imports this file. */
export interface MeteredDb {
  /** Drop-in D1 binding: pass as env.DB (see meteredEnv). */
  db: D1Database;
  /** Zero the counters (call right before the request you want to measure). */
  reset(): void;
  /** Rows D1 reported reading since reset(). */
  rowsRead(): number;
  /** Statements executed since reset(). */
  queries(): number;
  /** SQL text of each statement executed since reset(), in order (best effort; batch entries included). */
  statements(): string[];
}

type Meta = { rows_read?: number };

export function meteredDb(db: D1Database): MeteredDb {
  let rows = 0;
  let n = 0;
  const sqls: string[] = [];
  const inner = new WeakMap<object, D1PreparedStatement>();

  const count = (out: unknown) => {
    const meta = (out as { meta?: Meta } | null)?.meta;
    rows += Number(meta?.rows_read ?? 0);
  };

  const wrapStmt = (stmt: D1PreparedStatement, sql?: string): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(t, p) {
        const v = Reflect.get(t, p);
        if (typeof v !== "function") return v;
        if (p === "bind") return (...args: unknown[]) => wrapStmt(v.apply(t, args) as D1PreparedStatement, sql);
        if (p === "all" || p === "first" || p === "run" || p === "raw") {
          return async (...args: unknown[]) => {
            n++;
            sqls.push(sql ?? "");
            const out = await v.apply(t, args);
            count(out);
            return out;
          };
        }
        // .values(), .isChanges etc: keep the real receiver so internals still work.
        return (...args: unknown[]) => v.apply(t, args);
      },
    });
    inner.set(proxy, stmt);
    return proxy;
  };

  const wrapped = {
    prepare: (sql: string) => wrapStmt(db.prepare(sql), sql),
    batch: async (stmts: D1PreparedStatement[]) => {
      n += stmts.length;
      for (const s of stmts) {
        const real = inner.get(s as object) as D1PreparedStatement | undefined;
        sqls.push(real ? "" : "");
      }
      const out = await db.batch(stmts.map((s) => (inner.get(s as object) as D1PreparedStatement | undefined) ?? s) as never);
      for (const r of out as unknown[]) count(r);
      return out as never;
    },
    exec: (sql: string) => db.exec(sql),
    dump: () => db.dump(),
  } as unknown as D1Database;

  return {
    db: wrapped,
    reset() {
      rows = 0;
      n = 0;
      sqls.length = 0;
    },
    rowsRead: () => rows,
    queries: () => n,
    statements: () => [...sqls],
  };
}

/** env with DB swapped for the metered binding (everything else, e.g. FIXTURE_NDJSON, unchanged). */
export function meteredEnv<T extends { DB: D1Database }>(env: T, m: MeteredDb): T {
  return { ...env, DB: m.db };
}

/** One measured request: the response plus what it read. */
export interface Measured {
  status: number;
  body: string;
  rows: number;
  queries: number;
  sqls: string[];
}

/** Run one request through a handler with a metered DB and report its cost. */
export async function measure(
  m: MeteredDb,
  run: () => Promise<Response>,
): Promise<Measured> {
  m.reset();
  const res = await run();
  const body = await res.text();
  return { status: res.status, body, rows: m.rowsRead(), queries: m.queries(), sqls: m.statements() };
}

/** "BEFORE/AFTER table" line, so the note and the test log always agree. */
export function tableRow(label: string, hit: "first" | "repeat", x: Measured): string {
  return `${label}\t${hit}\t${x.status}\t${x.rows}\t${x.queries}`;
}
