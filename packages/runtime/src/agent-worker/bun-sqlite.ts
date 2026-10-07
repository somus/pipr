import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  type SqliteDatabase,
  type SqliteExecutor,
  SqliteStorage,
  type SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";

const walAutoCheckpointPages = 1_000;
const busyTimeoutMs = 5_000;
const ignore = () => {};

/**
 * Runs operations in call order. An asynchronous operation (a transaction) holds the queue until it settles, so work
 * submitted while it runs, including calls on the database from inside the callback, waits behind it.
 */
class SerialOperationQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  run<T>(operation: () => T): Promise<T> {
    if (this.pending > 0) {
      return this.enqueue(async () => operation());
    }
    try {
      return Promise.resolve(operation());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  runAsync<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending > 0) {
      return this.enqueue(operation);
    }
    this.pending += 1;
    const { promise: barrier, resolve: releaseBarrier } = Promise.withResolvers<void>();
    this.tail = barrier;
    let started: Promise<T>;
    try {
      started = operation();
    } catch (error) {
      started = Promise.reject(error);
    }
    return started.finally(() => {
      this.pending -= 1;
      releaseBarrier();
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const settled = this.tail.then(operation).finally(() => {
      this.pending -= 1;
    });
    this.tail = settled.then(ignore, ignore);
    return settled;
  }
}

type StatementCache = Map<string, Statement>;

abstract class BunSqliteExecutor implements SqliteExecutor {
  constructor(
    protected readonly database: Database,
    protected readonly statements: StatementCache,
  ) {}

  exec(sql: string): Promise<void> {
    return this.runOperation(() => {
      this.database.run(sql);
    });
  }

  run(sql: string, ...params: SqliteValue[]): Promise<void> {
    return this.runOperation(() => {
      this.statement(sql).run(...bindings(params));
    });
  }

  get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return this.runOperation(
      () => (this.statement(sql).get(...bindings(params)) ?? undefined) as T | undefined,
    );
  }

  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.runOperation(() => this.statement(sql).all(...bindings(params)) as T[]);
  }

  protected abstract runOperation<T>(operation: () => T): Promise<T>;

  private statement(sql: string): Statement {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.database.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
}

class BunSqliteTransaction extends BunSqliteExecutor {
  constructor(
    database: Database,
    statements: StatementCache,
    private readonly scope: { active: boolean },
  ) {
    super(database, statements);
  }

  protected async runOperation<T>(operation: () => T): Promise<T> {
    if (!this.scope.active) {
      throw new Error("SQLite transaction handle is no longer active");
    }
    return operation();
  }
}

/** `SqliteDatabase` facade over `bun:sqlite`, with the queueing and rollback contract pi-durable requires. */
class BunSqliteDatabase extends BunSqliteExecutor implements SqliteDatabase {
  private readonly access = new SerialOperationQueue();
  private closed = false;

  constructor(database: Database) {
    super(database, new Map());
  }

  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.access.runAsync(async () => {
      this.database.run("BEGIN IMMEDIATE");
      const scope = { active: true };
      try {
        const result = await callback(
          new BunSqliteTransaction(this.database, this.statements, scope),
        );
        scope.active = false;
        this.database.run("COMMIT");
        return result;
      } catch (error) {
        scope.active = false;
        try {
          this.database.run("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "SQLite transaction failed and rollback failed",
          );
        }
        throw error;
      }
    });
  }

  close(): Promise<void> {
    return this.access.run(() => {
      if (this.closed) {
        return;
      }
      this.closed = true;
      for (const statement of this.statements.values()) {
        statement.finalize();
      }
      this.statements.clear();
      try {
        this.database.run("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally {
        this.database.close();
      }
    });
  }

  protected runOperation<T>(operation: () => T): Promise<T> {
    return this.access.run(operation);
  }
}

export async function openBunSqliteDatabase(file: string): Promise<SqliteDatabase> {
  if (file !== ":memory:") {
    await mkdir(path.dirname(file), { recursive: true });
  }
  const database = new Database(file, { create: true, strict: true, safeIntegers: false });
  const adapter = new BunSqliteDatabase(database);
  try {
    await adapter.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    await adapter.exec("PRAGMA journal_mode = WAL");
    await adapter.exec("PRAGMA synchronous = NORMAL");
    await adapter.exec(`PRAGMA wal_autocheckpoint = ${walAutoCheckpointPages}`);
    return adapter;
  } catch (error) {
    await adapter.close().catch(ignore);
    throw error;
  }
}

/** Opens or creates file-backed durable harness storage through `bun:sqlite`. */
export async function openBunSqliteStorage(file: string): Promise<SqliteStorage> {
  return await SqliteStorage.open(await openBunSqliteDatabase(file));
}

function bindings(params: SqliteValue[]): SQLQueryBindings[] {
  return params as SQLQueryBindings[];
}
