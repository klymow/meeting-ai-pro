import postgres, { type Sql } from "postgres";

let client: Sql | undefined;

export function db(): Sql {
  if (!client) {
    const connectionString = process.env.POSTGRES_URL;
    if (!connectionString) {
      throw new Error("POSTGRES_URL is not configured.");
    }
    client = postgres(connectionString, {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
    });
  }
  return client;
}
