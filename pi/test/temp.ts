import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempRoot = join(packageRoot, ".test-tmp");

export async function makeTempDir(label: string): Promise<string> {
  await mkdir(tempRoot, { recursive: true });
  return mkdtemp(join(tempRoot, `${label}-`));
}

export async function removeTempDir(path: string): Promise<void> {
  if (!path.startsWith(`${tempRoot}/`)) throw new Error("Refusing to remove a path outside .test-tmp");
  await rm(path, { recursive: true, force: true });
}
