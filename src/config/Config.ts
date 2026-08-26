import { Config } from "effect"

/**
 * PostgreSQL connection settings (ADR-018).
 *
 * Read from `POSTGRES_*` environment variables. Replaces the `GEL_*` configuration that Gel's
 * discontinuation retired.
 */
export const PostgresConfig = Config.all({
  host: Config.string("HOST").pipe(Config.withDefault("localhost")),
  port: Config.port("PORT").pipe(Config.withDefault(5432)),
  username: Config.string("USER"),
  password: Config.redacted("PASSWORD"),
  database: Config.string("DATABASE")
}).pipe(Config.nested("POSTGRES"))

export type PostgresConfig = typeof PostgresConfig extends Config.Config<infer A> ? A : never
