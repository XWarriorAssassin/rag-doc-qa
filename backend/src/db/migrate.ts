import "dotenv/config";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set (check your .env file)");
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Extensions must exist before any migration references them (vector column,
  // gen_random_uuid()). Running this here — rather than baking it into the first
  // generated migration — means it survives `drizzle-kit generate` regenerating
  // that file from scratch.
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  `);

  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./src/db/migrations" });

  console.log("Migrations applied.");
  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
