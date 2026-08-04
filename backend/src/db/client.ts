import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set (check your .env file)");
}

// A pooled connection, not a single client. Express handles concurrent
// requests; a single pg.Client would serialize every query behind it.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

export const db = drizzle(pool, { schema });
