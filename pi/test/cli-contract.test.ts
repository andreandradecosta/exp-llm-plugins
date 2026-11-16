import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { modelInfoFixture, modelsFixture } from "./fixtures.ts";
import { makeTempDir, removeTempDir } from "./temp.ts";

const execute = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const extensionPath = join(packageRoot, "src", "index.ts");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTempDir));
});

describe("Pi CLI contract", () => {
  it("makes configured models available to --list-models using only a local mock gateway", { timeout: 30_000 }, async () => {
    const directory = await makeTempDir("cli-contract");
    directories.push(directory);
    const agentDir = join(directory, "agent");
    await mkdir(agentDir, { recursive: true });
    const fixtureToken = "local-cli-contract-token";
    const authorizationHeaders: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      authorizationHeaders.push(request.headers.authorization);
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/models") {
        response.end(JSON.stringify(modelsFixture));
      } else if (request.url === "/v1/model/info") {
        response.end(JSON.stringify(modelInfoFixture));
      } else {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "not found" }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Missing mock server address");
      await writeFile(join(agentDir, "exp-config.json"), JSON.stringify({
        baseUrl: `http://127.0.0.1:${address.port}`,
        defaultMaxTokens: 16_384,
        timeoutMs: 2_000,
      }));
      await writeFile(join(agentDir, "auth.json"), JSON.stringify({
        exp: { type: "api_key", key: fixtureToken },
      }), { mode: 0o600 });

      const { stdout, stderr } = await execute(process.execPath, [
        cliPath,
        "-e",
        extensionPath,
        "--list-models",
      ], {
        cwd: packageRoot,
        timeout: 25_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: directory,
          USER: "pi-contract-test",
          TERM: "dumb",
          NO_COLOR: "1",
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1",
          NO_PROXY: "127.0.0.1,localhost",
        },
      });
      const output = `${stdout}\n${stderr}`;
      expect(authorizationHeaders, output).toHaveLength(2);
      expect(output).toMatch(/exp\s+Kimi-K3\s/);
      expect(output).toMatch(/exp\s+Kimi-K3\.1-Pro\s/);
      expect(output).not.toContain("MiniMax-M3");
      expect(output).not.toContain(fixtureToken);
      expect(authorizationHeaders).toEqual([
        `Bearer ${fixtureToken}`,
        `Bearer ${fixtureToken}`,
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
