import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cleanupFixtures, fixture } from "./helpers";

afterEach(cleanupFixtures);

const scriptDir = resolve(import.meta.dir, "..");

describe("셸 래퍼와 제거", () => {
  test("최소 PATH에서 nvm 버전 숫자 내림차순과 NVM_BIN, .bun 우선순위를 지킨다", () => {
    const paths = fixture(false);
    const addBun = (bin: string) => {
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "bun"), "#!/bin/bash\nexit 99\n", { mode: 0o755 });
    };
    const findBun = (nvmBin?: string) => {
      const result = Bun.spawnSync(["/bin/bash", "-c", 'set -euo pipefail\nsource "$1/lib.sh"\ncommand -v bun', "mailman-path-test", scriptDir], {
        env: { HOME: paths.home, PATH: "/usr/bin:/bin", ...(nvmBin ? { NVM_BIN: nvmBin } : {}) },
      });
      expect(result.exitCode).toBe(0);
      return result.stdout.toString().trim();
    };
    for (const version of ["v9.99.99", "v24.9.10", "v24.11.0", "v24.11.1", "v22.99.99"]) {
      addBun(join(paths.home, ".nvm/versions/node", version, "bin"));
    }
    mkdirSync(join(paths.home, ".nvm/versions/node/v26.0.0/bin"), { recursive: true });
    expect(findBun()).toBe(join(paths.home, ".nvm/versions/node/v24.11.1/bin/bun"));
    const selected = join(paths.home, "selected node/bin");
    addBun(selected);
    expect(findBun(selected)).toBe(join(selected, "bun"));
    addBun(join(paths.home, ".bun/bin"));
    expect(findBun(selected)).toBe(join(paths.home, ".bun/bin/bun"));
  });

  test("uninstall은 두 커맨드의 파일/링크를 지우고 v2 DB·보조 파일·토큰은 보존하며 위치를 안내한다", () => {
    for (const customPaths of [false, true]) {
      const paths = fixture(false);
      const claudeHome = join(paths.home, ".claude");
      const commandsDir = join(claudeHome, "commands");
      mkdirSync(commandsDir, { recursive: true });
      for (const command of ["mailman", "mailman-deep"]) {
        const file = join(commandsDir, `${command}.md`);
        if ((command === "mailman") === customPaths) symlinkSync(join(paths.home, "missing-command.md"), file);
        else writeFileSync(file, "커맨드 fixture");
      }
      const runtimeDir = join(paths.home, "runtime");
      mkdirSync(runtimeDir);
      writeFileSync(join(runtimeDir, "keep.txt"), "런타임 링크 대상 유지");
      const scriptsDir = join(claudeHome, "scripts/mailman");
      mkdirSync(dirname(scriptsDir), { recursive: true });
      symlinkSync(runtimeDir, scriptsDir);
      const dataHome = customPaths ? join(paths.home, "custom-data") : claudeHome;
      const dbFile = join(dataHome, "inbox/mailman-v2.db");
      const tokenFile = customPaths ? join(paths.home, "custom-secrets/token.json") : join(claudeHome, "secrets/mailman-token.json");
      const retainedFiles = [dbFile, `${dbFile}-wal`, `${dbFile}-shm`, tokenFile];
      for (const file of retainedFiles) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, "보존할 데이터 fixture");
      }
      const result = Bun.spawnSync(["/bin/bash", resolve(scriptDir, "../../uninstall.sh")], {
        env: { HOME: paths.home, PATH: "/usr/bin:/bin", ...(customPaths ? { MAILMAN_HOME: dataHome, MAILMAN_TOKEN_FILE: tokenFile } : {}) },
      });
      expect(result.exitCode).toBe(0);
      expect(readdirSync(commandsDir)).toEqual([]);
      expect(existsSync(scriptsDir)).toBe(false);
      expect(readFileSync(join(runtimeDir, "keep.txt"), "utf8")).toBe("런타임 링크 대상 유지");
      for (const file of retainedFiles) expect(readFileSync(file, "utf8")).toBe("보존할 데이터 fixture");
      expect(result.stdout.toString()).toContain(`${dbFile}*`);
      expect(result.stdout.toString()).toContain(tokenFile);
    }
  });
});
