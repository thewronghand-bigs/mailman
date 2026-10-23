import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cleanupFixtures, fixture } from "./helpers";

afterEach(cleanupFixtures);

const scriptDir = resolve(import.meta.dir, "..");
const repoRoot = resolve(scriptDir, "../..");
const devRunner = join(scriptDir, "mailman-dev");

function addBun(bin: string, body = "#!/bin/bash\nexit 99\n") {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "bun"), body, { mode: 0o755 });
}

describe("개발 실행기와 설치/제거", () => {
  test("최소 PATH에서 nvm 버전 숫자 내림차순과 NVM_BIN, .bun 우선순위를 지킨다", () => {
    const paths = fixture(false);
    const findBun = (nvmBin?: string) => {
      const result = Bun.spawnSync(["/bin/bash", "-c", 'set -euo pipefail\nsource "$1"\nmailman_setup_path\ncommand -v bun', "mailman-path-test", devRunner], {
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

  test("심볼릭 링크로 실행해도 레포의 cli.ts에 인자를 그대로 넘긴다", () => {
    const paths = fixture(false);
    // 가짜 bun은 받은 인자만 출력한다. 실제 cli.ts는 실행하지 않는다.
    addBun(join(paths.home, ".bun/bin"), '#!/bin/bash\nprintf "%s\\n" "$@"\n');
    const link = join(paths.home, "nested/bin/mailman");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join("..", "..", "relative-link"), link);
    symlinkSync(devRunner, join(paths.home, "relative-link"));
    const result = Bun.spawnSync([link, "fetch", "--only", "bot", "공백 있는 인자"], { env: { HOME: paths.home, PATH: "/usr/bin:/bin" } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim().split("\n")).toEqual([join(scriptDir, "cli.ts"), "fetch", "--only", "bot", "공백 있는 인자"]);
  });

  test("bun이 없으면 개발 실행기는 안내 후 exit 1이다", () => {
    const paths = fixture(false);
    const result = Bun.spawnSync(["/bin/bash", devRunner, "--version"], { env: { HOME: paths.home, PATH: "/usr/bin:/bin" } });
    if (existsSync("/opt/homebrew/bin/bun") || existsSync("/usr/local/bin/bun")) return; // 시스템 bun이 있으면 확인할 수 없다.
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("bun을 찾을 수 없습니다");
  });

  test("install.sh --dev는 실행 파일·커맨드를 링크하고 백업하되 설정 파일을 만들거나 수정하지 않는다", () => {
    const paths = fixture(false);
    const home = join(paths.home, "home");
    const claude = join(home, ".claude");
    mkdirSync(join(claude, "commands"), { recursive: true });
    writeFileSync(join(claude, "commands/mailman.md"), "예전 커맨드");
    mkdirSync(join(claude, "scripts/mailman"), { recursive: true });
    addBun(join(home, ".bun/bin"));
    const run = () => Bun.spawnSync(["/bin/bash", join(repoRoot, "install.sh"), "--dev"], {
      env: { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: paths.home },
    });

    const first = run();
    expect(first.exitCode).toBe(0);
    expect(readlinkSync(join(claude, "bin/mailman"))).toBe(devRunner);
    for (const command of ["mailman", "mailman-deep"]) {
      expect(readlinkSync(join(claude, `commands/${command}.md`))).toBe(join(repoRoot, `commands/${command}.md`));
    }
    const backups = readdirSync(join(claude, "commands")).filter(name => name.startsWith("mailman.md.bak."));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(claude, "commands", backups[0]!), "utf8")).toBe("예전 커맨드");
    const config = join(claude, "mailman/config.json");
    expect(existsSync(config)).toBe(false);
    expect(existsSync(dirname(config))).toBe(false);
    const stdout = first.stdout.toString();
    expect(stdout).toContain("https://thewronghand-bigs.github.io/mailman/setup");
    expect(stdout).toContain("auth --client");
    expect(stdout).toContain("spaces '검색어' --save dev");
    expect(stdout).toContain("첫 --save가 0600 설정 파일을 만들고 그 별칭을 기본 방으로");
    expect(stdout).toContain("--default");
    expect(stdout).toContain(join(claude, "scripts/mailman"));
    expect(stdout).not.toContain("bun을 찾을 수 없습니다");

    // 재실행은 같은 링크와 기존 설정을 그대로 두고 새 백업을 만들지 않는다.
    mkdirSync(dirname(config), { recursive: true });
    const existingConfig = '{"defaultSpace":"mine","spaces":{"mine":{"space":"spaces/MINE"}}}';
    writeFileSync(config, existingConfig, { mode: 0o640 });
    const second = run();
    expect(second.exitCode).toBe(0);
    expect(second.stdout.toString()).toContain("이미 연결됨");
    expect(readdirSync(join(claude, "commands")).filter(name => name.includes(".bak."))).toHaveLength(1);
    expect(readFileSync(config, "utf8")).toBe(existingConfig);
    expect(statSync(config).mode & 0o777).toBe(0o640);
    expect(readdirSync(paths.home).filter(name => name.startsWith("mailman-config."))).toEqual([]);
    expect(existsSync(join(claude, "scripts/mailman"))).toBe(true);
  });

  test("uninstall은 실행 파일·커맨드·이전 설치 링크를 지우고 설정·DB·인증정보는 보존하며 위치를 안내한다", () => {
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
      const binFile = join(claudeHome, "bin/mailman");
      mkdirSync(dirname(binFile), { recursive: true });
      if (customPaths) symlinkSync(devRunner, binFile);
      else writeFileSync(binFile, "바이너리 fixture", { mode: 0o755 });
      writeFileSync(`${binFile}.bak`, "직전 바이너리 fixture");
      // Codex 스킬: 개발 설치는 디렉터리 링크, 릴리스 설치는 실제 디렉터리 + 백업 파일.
      const codexHome = customPaths ? join(paths.home, "custom-codex") : join(paths.home, ".codex");
      const skillDir = join(codexHome, "skills/mailman");
      const skillLinkTarget = join(paths.home, "skill-link-target");
      mkdirSync(skillLinkTarget);
      writeFileSync(join(skillLinkTarget, "SKILL.md"), "레포 스킬 fixture");
      mkdirSync(dirname(skillDir), { recursive: true });
      if (customPaths) symlinkSync(skillLinkTarget, skillDir);
      else {
        mkdirSync(skillDir);
        writeFileSync(join(skillDir, "SKILL.md"), "설치된 스킬 fixture");
        writeFileSync(join(skillDir, "SKILL.md.bak.20260101000000"), "스킬 백업 fixture");
        writeFileSync(join(commandsDir, "mailman.md.bak.20260101000000"), "커맨드 백업 fixture");
      }
      const runtimeDir = join(paths.home, "runtime");
      mkdirSync(runtimeDir);
      writeFileSync(join(runtimeDir, "keep.txt"), "런타임 링크 대상 유지");
      const legacyDir = join(claudeHome, "scripts/mailman");
      mkdirSync(dirname(legacyDir), { recursive: true });
      if (customPaths) symlinkSync(runtimeDir, legacyDir);
      else {
        mkdirSync(legacyDir);
        writeFileSync(join(legacyDir, "config.json"), "예전 설정 fixture");
      }
      const dataHome = customPaths ? join(paths.home, "custom-data") : claudeHome;
      const dbFile = join(dataHome, "inbox/mailman-v2.db");
      const tokenFile = customPaths ? join(paths.home, "custom-secrets/token.json") : join(claudeHome, "secrets/mailman-token.json");
      const clientFile = customPaths ? join(paths.home, "custom-secrets/client.json") : join(claudeHome, "secrets/mailman-oauth.json");
      const configFile = customPaths ? join(paths.home, "custom-config.json") : join(claudeHome, "mailman/config.json");
      const retainedFiles = [dbFile, `${dbFile}-wal`, `${dbFile}-shm`, tokenFile, clientFile, configFile];
      for (const file of retainedFiles) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, "보존할 데이터 fixture");
      }
      const result = Bun.spawnSync(["/bin/bash", join(repoRoot, "uninstall.sh")], {
        env: { HOME: paths.home, PATH: "/usr/bin:/bin", ...(customPaths
          ? { MAILMAN_HOME: dataHome, MAILMAN_TOKEN_FILE: tokenFile, MAILMAN_CLIENT_FILE: clientFile, MAILMAN_CONFIG: configFile, CODEX_HOME: codexHome } : {}) },
      });
      expect(result.exitCode).toBe(0);
      expect(readdirSync(commandsDir)).toEqual(customPaths ? [] : ["mailman.md.bak.20260101000000"]);
      expect(() => lstatSync(binFile)).toThrow();
      expect(() => lstatSync(`${binFile}.bak`)).toThrow();
      if (customPaths) expect(() => lstatSync(skillDir)).toThrow();
      else expect(readdirSync(skillDir)).toEqual(["SKILL.md.bak.20260101000000"]);
      expect(readFileSync(join(skillLinkTarget, "SKILL.md"), "utf8")).toBe("레포 스킬 fixture");
      expect(readFileSync(devRunner, "utf8")).toContain("mailman_setup_path");
      if (customPaths) expect(() => lstatSync(legacyDir)).toThrow();
      else expect(readFileSync(join(legacyDir, "config.json"), "utf8")).toBe("예전 설정 fixture");
      expect(readFileSync(join(runtimeDir, "keep.txt"), "utf8")).toBe("런타임 링크 대상 유지");
      for (const file of retainedFiles) expect(readFileSync(file, "utf8")).toBe("보존할 데이터 fixture");
      const stdout = result.stdout.toString();
      for (const location of [`${dbFile}*`, tokenFile, clientFile, configFile]) expect(stdout).toContain(location);
      if (!customPaths) {
        expect(stdout).toContain(join(commandsDir, "mailman.md.bak.20260101000000"));
        expect(stdout).toContain(join(skillDir, "SKILL.md.bak.20260101000000"));
      }
    }
  });
});


// 네트워크 없이 릴리스 설치를 검증한다. PATH 앞에 둔 가짜 curl이 FAKE_SERVER 디렉터리의 파일을 돌려준다.
const FAKE_TAG = "v9.9.9";
const FAKE_CURL = `#!/bin/bash
out=""; url=""; head=0
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    -w) shift ;;
    -*I*) head=1 ;;
    -*) ;;
    *) url="$1" ;;
  esac
  shift
done
echo "$url" >> "$FAKE_SERVER/requests.log"
if [ -n "\${FAKE_FAIL:-}" ] && [[ "$url" == *"$FAKE_FAIL"* ]]; then exit 22; fi
if [ "$head" = 1 ]; then printf '%s' "https://github.com/thewronghand-bigs/mailman/releases/tag/${FAKE_TAG}"; exit 0; fi
file="$FAKE_SERVER/\${url#https://}"
[ -f "$file" ] || exit 22
cp "$file" "$out"
`;

function releaseFixture() {
  const paths = fixture(false);
  const home = join(paths.home, "home");
  const server = join(paths.home, "server");
  const fakeBin = join(paths.home, "fake-bin");
  const tmp = join(paths.home, "tmp");
  for (const dir of [home, fakeBin, tmp]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(fakeBin, "curl"), FAKE_CURL, { mode: 0o755 });
  const raw = join(server, "raw.githubusercontent.com/thewronghand-bigs/mailman", FAKE_TAG);
  for (const file of ["commands/mailman.md", "commands/mailman-deep.md", "codex-skills/mailman/SKILL.md"]) {
    mkdirSync(dirname(join(raw, file)), { recursive: true });
    writeFileSync(join(raw, file), readFileSync(join(repoRoot, file)));
  }
  // 릴리스 자산은 --version에 성공하는 가짜 실행 파일이다. 버전 문자열로 교체 여부를 구분한다.
  const publishBinary = (version: string) => {
    const dir = join(server, "github.com/thewronghand-bigs/mailman/releases/download", FAKE_TAG);
    mkdirSync(dir, { recursive: true });
    for (const arch of ["arm64", "x64"]) writeFileSync(join(dir, `mailman-darwin-${arch}`), `#!/bin/bash\necho "mailman ${version}"\n`);
  };
  const claude = join(home, ".claude");
  const codexHome = join(home, "codex-home");
  const run = (target: string, extraEnv: Record<string, string> = {}) => Bun.spawnSync(["/bin/bash", "-s", "--", "--target", target], {
    // curl | bash 와 같이 stdin으로 스크립트를 넘긴다.
    stdin: readFileSync(join(repoRoot, "install.sh")),
    env: { HOME: home, PATH: `${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`, TMPDIR: tmp, CODEX_HOME: codexHome, FAKE_SERVER: server, ...extraEnv },
  });
  const leftovers = () => [
    ...readdirSync(tmp),
    ...[join(claude, "bin"), join(claude, "commands"), join(codexHome, "skills/mailman")]
      .filter(dir => existsSync(dir)).flatMap(dir => readdirSync(dir).filter(name => name.startsWith("."))),
  ];
  return { home, claude, codexHome, server, publishBinary, run, leftovers };
}

describe("install.sh 릴리스 모드 (가짜 curl)", () => {
  test("모든 파일을 받아 검증한 뒤 설치하고, 중간 다운로드가 실패하면 기존 설치를 그대로 둔다", () => {
    const env = releaseFixture();
    const bin = join(env.claude, "bin/mailman");
    const skill = join(env.codexHome, "skills/mailman/SKILL.md");
    // 옛 개발 설치의 Codex 스킬 링크와 옛 Codex 어댑터가 있는 상태에서 시작한다.
    const repoLike = join(env.home, "repo-skill");
    mkdirSync(repoLike);
    writeFileSync(join(repoLike, "SKILL.md"), "레포 스킬 원본");
    mkdirSync(join(env.codexHome, "skills"), { recursive: true });
    symlinkSync(repoLike, join(env.codexHome, "skills/mailman"));
    mkdirSync(join(env.home, ".local/bin"), { recursive: true });
    writeFileSync(join(env.home, ".local/bin/mailman"), "옛 어댑터", { mode: 0o755 });

    env.publishBinary("v1");
    const first = env.run("all");
    expect(first.exitCode).toBe(0);
    expect(readFileSync(bin, "utf8")).toContain("mailman v1");
    expect(statSync(bin).mode & 0o777).toBe(0o755);
    for (const command of ["mailman", "mailman-deep"]) {
      expect(readFileSync(join(env.claude, `commands/${command}.md`), "utf8")).toBe(readFileSync(join(repoRoot, `commands/${command}.md`), "utf8"));
    }
    expect(lstatSync(join(env.codexHome, "skills/mailman")).isDirectory()).toBe(true);
    expect(readFileSync(skill, "utf8")).toBe(readFileSync(join(repoRoot, "codex-skills/mailman/SKILL.md"), "utf8"));
    // 링크는 skills/ 밖으로 옮겨지고, 링크가 가리키던 레포 파일은 그대로다.
    const codexBackups = readdirSync(env.codexHome).filter(name => name.startsWith("mailman-skill.bak."));
    expect(codexBackups).toHaveLength(1);
    expect(readlinkSync(join(env.codexHome, codexBackups[0]!))).toBe(repoLike);
    expect(readFileSync(join(repoLike, "SKILL.md"), "utf8")).toBe("레포 스킬 원본");
    const config = join(env.claude, "mailman/config.json");
    expect(existsSync(config)).toBe(false);
    expect(existsSync(dirname(config))).toBe(false);
    expect(existsSync(`${bin}.bak`)).toBe(false);
    expect(env.leftovers()).toEqual([]);
    const stdout = first.stdout.toString();
    expect(stdout).toContain("옛 Codex 어댑터");
    expect(stdout).toContain("$mailman");
    expect(stdout).toContain("export PATH=");
    expect(readFileSync(join(env.home, ".local/bin/mailman"), "utf8")).toBe("옛 어댑터");
    const requests = readFileSync(join(env.server, "requests.log"), "utf8");
    expect(requests).toContain(`/releases/download/${FAKE_TAG}/mailman-darwin-`);
    expect(requests).toContain(`/${FAKE_TAG}/codex-skills/mailman/SKILL.md`);
    expect(requests).not.toContain("config.example.json");

    // 첫 --save 등으로 생긴 설정은 재설치·다운로드 실패 때도 내용과 권한을 보존한다.
    mkdirSync(dirname(config), { recursive: true });
    const existingConfig = '{"defaultSpace":"mine","spaces":{"mine":{"space":"spaces/MINE"}}}';
    writeFileSync(config, existingConfig, { mode: 0o640 });

    // 새 바이너리는 받았지만 커맨드 하나가 실패하면 아무것도 바꾸지 않는다.
    env.publishBinary("v2");
    const commandBefore = readFileSync(join(env.claude, "commands/mailman.md"), "utf8");
    for (const failing of ["commands/mailman-deep.md", "codex-skills/mailman/SKILL.md", "mailman-darwin-"]) {
      const failed = env.run("all", { FAKE_FAIL: failing });
      expect(failed.exitCode).not.toBe(0);
      expect(failed.stderr.toString()).toContain(`[mailman] 다운로드 실패: `);
      expect(failed.stderr.toString()).toContain("기존 설치는 바꾸지 않았습니다");
      expect(readFileSync(bin, "utf8")).toContain("mailman v1");
      expect(existsSync(`${bin}.bak`)).toBe(false);
      expect(readFileSync(join(env.claude, "commands/mailman.md"), "utf8")).toBe(commandBefore);
      expect(readFileSync(config, "utf8")).toBe(existingConfig);
      expect(statSync(config).mode & 0o777).toBe(0o640);
      expect(env.leftovers()).toEqual([]);
    }

    // 성공하면 직전 바이너리 1개만 mailman.bak으로 남는다. 다음 교체 때 덮어쓴다.
    expect(env.run("all").exitCode).toBe(0);
    expect(readFileSync(bin, "utf8")).toContain("mailman v2");
    expect(readFileSync(`${bin}.bak`, "utf8")).toContain("mailman v1");
    env.publishBinary("v3");
    const third = env.run("claude");
    expect(third.exitCode).toBe(0);
    expect(readFileSync(bin, "utf8")).toContain("mailman v3");
    expect(readFileSync(`${bin}.bak`, "utf8")).toContain("mailman v2");
    expect(readdirSync(join(env.claude, "bin")).sort()).toEqual(["mailman", "mailman.bak"]);
    // 같은 내용인 커맨드·스킬은 백업 없이 그대로 둔다.
    expect(third.stdout.toString()).toContain("변경 없음");
    expect(readdirSync(join(env.claude, "commands")).filter(name => name.includes(".bak."))).toEqual([]);
    expect(readdirSync(join(env.codexHome, "skills/mailman"))).toEqual(["SKILL.md"]);
    expect(readFileSync(config, "utf8")).toBe(existingConfig);
    expect(statSync(config).mode & 0o777).toBe(0o640);
    expect(env.leftovers()).toEqual([]);
  }, 15_000); // 여러 번의 설치·검증 자식 프로세스가 5초를 넘을 수 있다.

  test("codex 대상은 커맨드를 설치하지 않고, 잘못된 대상은 아무것도 받지 않는다", () => {
    const env = releaseFixture();
    env.publishBinary("v1");
    const codexOnly = env.run("codex");
    expect(codexOnly.exitCode).toBe(0);
    expect(existsSync(join(env.claude, "bin/mailman"))).toBe(true);
    expect(existsSync(join(env.claude, "commands"))).toBe(false);
    expect(existsSync(join(env.codexHome, "skills/mailman/SKILL.md"))).toBe(true);
    expect(codexOnly.stdout.toString()).not.toContain("/mailman 을 실행");

    // MAILMAN_TARGET 환경변수도 받는다. 명령행 --target이 우선한다.
    const viaEnv = Bun.spawnSync(["/bin/bash", "-s"], {
      stdin: readFileSync(join(repoRoot, "install.sh")),
      env: { HOME: env.home, PATH: "/usr/bin:/bin", MAILMAN_TARGET: "nope" },
    });
    expect(viaEnv.exitCode).toBe(1);
    expect(viaEnv.stderr.toString()).toContain("claude, codex, all");
    const requestCount = () => readFileSync(join(env.server, "requests.log"), "utf8").split("\n").filter(Boolean).length;
    const before = requestCount();
    const invalid = env.run("nope");
    expect(invalid.exitCode).toBe(1);
    expect(requestCount()).toBe(before);
  });
});

describe("install.sh --dev --target all", () => {
  test("실행 파일·커맨드는 파일 링크, Codex 스킬은 디렉터리 링크로 연결하고 기존 것은 백업한다", () => {
    const paths = fixture(false);
    const home = join(paths.home, "home");
    const claude = join(home, ".claude");
    const codexHome = join(paths.home, "codex-home");
    mkdirSync(join(claude, "bin"), { recursive: true });
    writeFileSync(join(claude, "bin/mailman"), "릴리스 바이너리");
    mkdirSync(join(codexHome, "skills/mailman"), { recursive: true });
    writeFileSync(join(codexHome, "skills/mailman/SKILL.md"), "옛 스킬");
    addBun(join(home, ".bun/bin"));
    const run = () => Bun.spawnSync(["/bin/bash", join(repoRoot, "install.sh"), "--dev", "--target", "all"], {
      env: { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: paths.home, CODEX_HOME: codexHome },
    });

    const first = run();
    expect(first.exitCode).toBe(0);
    expect(readlinkSync(join(claude, "bin/mailman"))).toBe(devRunner);
    expect(readFileSync(join(claude, "bin/mailman.bak"), "utf8")).toBe("릴리스 바이너리");
    for (const command of ["mailman", "mailman-deep"]) {
      expect(readlinkSync(join(claude, `commands/${command}.md`))).toBe(join(repoRoot, `commands/${command}.md`));
    }
    // Codex는 링크된 SKILL.md 파일을 읽지 않으므로 디렉터리를 링크한다.
    expect(readlinkSync(join(codexHome, "skills/mailman"))).toBe(join(repoRoot, "codex-skills/mailman"));
    const backups = readdirSync(codexHome).filter(name => name.startsWith("mailman-skill.bak."));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(codexHome, backups[0]!, "SKILL.md"), "utf8")).toBe("옛 스킬");
    expect(readdirSync(join(codexHome, "skills"))).toEqual(["mailman"]);

    const second = run();
    expect(second.exitCode).toBe(0);
    expect(second.stdout.toString()).toContain(`이미 연결됨: ${join(codexHome, "skills/mailman")}`);
    expect(readdirSync(codexHome).filter(name => name.startsWith("mailman-skill.bak."))).toHaveLength(1);
    expect(readFileSync(join(claude, "bin/mailman.bak"), "utf8")).toBe("릴리스 바이너리");
    expect(readdirSync(join(claude, "bin")).sort()).toEqual(["mailman", "mailman.bak"]);
  });

  test("빈 Codex 스킬 디렉터리는 백업 없이 링크로 바꾼다", () => {
    const paths = fixture(false);
    const home = join(paths.home, "home");
    const codexHome = join(home, ".codex");
    mkdirSync(join(codexHome, "skills/mailman"), { recursive: true });
    addBun(join(home, ".bun/bin"));
    const result = Bun.spawnSync(["/bin/bash", join(repoRoot, "install.sh"), "--dev", "--target=codex"], {
      env: { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: paths.home },
    });
    expect(result.exitCode).toBe(0);
    expect(readlinkSync(join(codexHome, "skills/mailman"))).toBe(join(repoRoot, "codex-skills/mailman"));
    expect(readdirSync(codexHome)).toEqual(["skills"]);
    expect(existsSync(join(home, ".claude/commands"))).toBe(false);
  });
});
