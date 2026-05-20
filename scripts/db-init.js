import dotenv from "dotenv";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, query } from "../src/db.js";

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

// 读取迁移目录中按名称排序的 SQL 文件。
async function listMigrationFiles() {
  const names = await fs.readdir(migrationsDir);
  return names
    .filter(isSqlFile)
    .sort()
    .map(toMigrationPath);
}

// 执行单个 SQL 文件。
async function runMigration(filePath) {
  const sql = await fs.readFile(filePath, "utf8");
  await query(sql);
  console.log(`已执行迁移: ${path.basename(filePath)}`);
}

// 按顺序执行所有迁移文件。
async function runAllMigrations() {
  const files = await listMigrationFiles();
  for (let i = 0; i < files.length; i += 1) {
    await runMigration(files[i]);
  }
}

// 初始化数据库并确保连接被正确关闭。
async function main() {
  try {
    await runAllMigrations();
    console.log("数据库初始化完成");
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
