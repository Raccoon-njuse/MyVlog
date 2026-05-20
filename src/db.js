import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgres://myvlog:myvlog@127.0.0.1:5432/myvlog",
  max: Number(process.env.PG_POOL_MAX || 10)
});

// 执行一条带参数的数据库查询。
export function query(sql, params) {
  return pool.query(sql, params);
}

// 在事务中执行一组数据库操作。
export async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// 关闭数据库连接池。
export async function closePool() {
  await pool.end();
}
