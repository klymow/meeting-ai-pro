import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import postgres from "postgres";

const connectionString = process.env.POSTGRES_URL;
if (!connectionString) {
  throw new Error("POSTGRES_URL is required. Load .env.local before running db:init.");
}

const sql = postgres(connectionString, { max: 1 });
try {
  const schema = await readFile(path.join(process.cwd(), "db", "schema.sql"), "utf8");
  await sql.unsafe(schema);
  console.log("Database schema is ready.");
} finally {
  await sql.end();
}
