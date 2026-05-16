import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
declare let pool: pg.Pool | null;
declare let db: ReturnType<typeof drizzle> | null;
export { pool, db };
export * from "./schema";
//# sourceMappingURL=index.d.ts.map