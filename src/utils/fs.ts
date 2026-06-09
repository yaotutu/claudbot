import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

export function expandPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

export async function ensureDir(path: string): Promise<void> {
  await Bun.$`mkdir -p ${path}`.quiet();
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  const file = Bun.file(path);
  if (!(await file.exists())) return fallback;
  return (await file.json()) as T;
}

let tmpCounter = 0;
function uniqueTmpSuffix(): string {
  return `${process.pid}.${Date.now()}.${++tmpCounter}.${Math.random().toString(36).slice(2, 8)}`;
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  if (!path) throw new Error("writeJsonAtomic: path is empty");
  await ensureDir(dirname(path));
  const tmp = `${path}.${uniqueTmpSuffix()}.tmp`;
  await Bun.write(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await Bun.$`mv ${tmp} ${path}`.quiet();
}

export async function writeTextAtomic(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.${uniqueTmpSuffix()}.tmp`;
  await Bun.write(tmp, content);
  await Bun.$`mv ${tmp} ${path}`.quiet();
}
