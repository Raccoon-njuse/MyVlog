import dotenv from "dotenv";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, query, withTransaction } from "../src/db.js";

dotenv.config();

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const projectRoot = path.resolve(currentDir, "..");
const migrationsDir = path.join(projectRoot, "migrations");

// 判断文件名是否是 SQL 迁移文件。
function isSqlFile(name) {
  return name.endsWith(".sql");
}

// 把迁移文件名转换成绝对路径。
function toMigrationPath(name) {
  return path.join(migrationsDir, name);
}

// 从迁移文件路径中提取迁移编号和名称。
function toMigrationRecord(filePath) {
  const filename = path.basename(filePath);
  return {
    id: filename,
    path: filePath
  };
}

// 读取迁移目录中按名称排序的 SQL 文件。
async function listMigrationFiles() {
  const names = await fs.readdir(migrationsDir);
  return names
    .filter(isSqlFile)
    .sort()
    .map(toMigrationPath);
}

// 确保迁移记录表存在，用于避免重复执行已应用的迁移。
async function ensureMigrationTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      executed_at timestamptz NOT NULL DEFAULT now()
    );

    COMMENT ON TABLE schema_migrations IS '数据库迁移记录表';
    COMMENT ON COLUMN schema_migrations.id IS '已执行迁移文件名';
    COMMENT ON COLUMN schema_migrations.executed_at IS '迁移执行时间';
  `);
}

// 读取数据库中已经记录为完成的迁移。
async function listAppliedMigrationIds() {
  const result = await query("SELECT id FROM schema_migrations ORDER BY id");
  return new Set(result.rows.map(function getMigrationId(row) {
    return row.id;
  }));
}

// 执行单个 SQL 文件，并在同一事务中写入迁移记录。
async function runMigration(record) {
  const sql = await fs.readFile(record.path, "utf8");
  await withTransaction(async function runMigrationTransaction(client) {
    await client.query(sql);
    await client.query(
      `
        INSERT INTO schema_migrations (id)
        VALUES ($1)
        ON CONFLICT (id) DO NOTHING
      `,
      [record.id]
    );
  });
  console.log(`已执行迁移: ${record.id}`);
}

// 按顺序执行尚未记录的迁移文件。
async function runPendingMigrations() {
  await ensureMigrationTable();
  const files = await listMigrationFiles();
  const records = files.map(toMigrationRecord);
  const appliedIds = await listAppliedMigrationIds();
  let executedCount = 0;

  for (let i = 0; i < records.length; i += 1) {
    if (appliedIds.has(records[i].id)) {
      console.log(`跳过已执行迁移: ${records[i].id}`);
      continue;
    }
    await runMigration(records[i]);
    executedCount += 1;
  }

  if (executedCount === 0) {
    console.log("没有待执行迁移");
  }
}

// 执行数据库迁移并确保连接被正确关闭。
async function main() {
  try {
    await runPendingMigrations();
    console.log("数据库迁移完成");
  } finally {
    await closePool();
  }
}

// 输出初始化失败原因并设置失败退出码。
function handleFatalError(error) {
  console.error(error);
  process.exitCode = 1;
}

main().catch(handleFatalError);
