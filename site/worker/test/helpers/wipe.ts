/** Test-only: clear tables between tests. M4 tables carry append-only triggers (0027), so the delete trigger is dropped,
 * the table cleared, and the trigger recreated from the migration text, leaving the database as the migration made it. */
import MIG27 from "../../migrations/0027_m4_append_only.sql?raw";
export async function wipe(db: D1Database, tables: string[]) {
  for (const t of tables) {
    const trig = MIG27.split("\n").find((l) => l.startsWith(`CREATE TRIGGER IF NOT EXISTS ${t}_no_delete `));
    if (trig) await db.prepare(`DROP TRIGGER IF EXISTS ${t}_no_delete`).run();
    await db.prepare(`DELETE FROM ${t}`).run();
    if (trig) await db.prepare(trig).run();
  }
}
