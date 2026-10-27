// 점검 중 파일·DB를 만들지 않는다. 외부 오류 본문 대신 원인과 해결 단계만 표시한다.
import { existsSync, readFileSync, statSync } from "node:fs";
import { DIRECTORY_SCOPE, loadClient, loadToken, REACTION_SCOPE, refreshAccessToken, SPACE_CREATE_SCOPE, type OAuthClient, type SavedToken } from "./auth";
import { ChatClient, directoryErrorMessage } from "./chat";
import { isRecord, MailmanError, redact, RequestError } from "./errors";
import type { Fetch } from "./http";
import { loadConfig, SETUP_GUIDE_URL, type RuntimePaths } from "./runtime";

type Status = "✅" | "⚠️" | "❌";
type Failure = { message: string; step: number };

// 원문은 분류에만 사용한다. 알 수 없는 오류도 응답·자격증명을 그대로 출력하지 않는다.
function classifyFailure(error: unknown, phase: "refresh" | "chat"): Failure {
  const status = error instanceof RequestError ? error.status : undefined;
  const apiStatus = error instanceof RequestError ? error.apiStatus ?? "" : "";
  const message = error instanceof MailmanError ? error.message : "";
  const reasons = error instanceof RequestError ? error.apiReasons.join(" ") : "";
  const hint = `${apiStatus} ${reasons} ${message}`;
  if (phase === "refresh" && /^(invalid_client|deleted_client|unauthorized_client)$/i.test(apiStatus)) {
    return { message: "이 OAuth 클라이언트가 삭제·비활성화됨 — 클라이언트를 준 사람에게 새 JSON을 받거나 6단계에서 직접 만든 뒤 mailman auth --client <파일>로 등록하세요.", step: 6 };
  }
  if (/invalid_grant/i.test(hint)) return { message: "로그인이 만료됨 — 7일 만료(테스트 모드)였다면 5단계에서 게시한 후 mailman auth를 다시 실행하세요.", step: 5 };
  if (/admin_policy_enforced/i.test(hint) || status === 403 && /admin|policy|관리자|정책/i.test(hint)) {
    return { message: "관리자 정책으로 차단됨 — 회사 Google Workspace 관리자에게 앱 접근 허용을 문의하세요.", step: 8 };
  }
  if (/access_denied/i.test(hint)) return { message: "인증 접근이 거부됨 — 게시 상태 또는 테스트 사용자 등록을 확인하세요.", step: 5 };
  if (/SERVICE_DISABLED|has not been used/i.test(hint)) return { message: "Google Chat API가 사용 설정되지 않음 (SERVICE_DISABLED).", step: 2 };
  if (phase === "chat" && (status === 404 || /Chat app not found/i.test(hint))) {
    return { message: "Google Chat 앱 구성이 없음 (Chat app not found) — 회사 계정으로 구성하세요.", step: 7 };
  }
  if (status === 401) return { message: "인증이 거부됨 (HTTP 401) — mailman auth를 다시 실행하세요.", step: 8 };
  if (error instanceof RequestError && status === undefined) return { message: "네트워크 연결 실패 — 인터넷·프록시·방화벽을 확인한 뒤 mailman doctor를 다시 실행하세요.", step: 9 };
  if (phase === "refresh") return { message: "토큰 갱신 실패 — 클라이언트와 허용 권한을 확인하고 mailman auth를 다시 실행하세요.", step: 8 };
  if (status === 403) return { message: "Chat API 접근 권한 부족 (HTTP 403) — 허용 권한과 회사 계정의 앱 공개 범위를 확인하세요.", step: 7 };
  return { message: "Chat API 점검 실패 — 잠시 후 mailman doctor를 다시 실행하고 설정을 확인하세요.", step: 9 };
}

export async function runDoctor(paths: RuntimePaths, version: string, fetcher: Fetch, write: (text: string) => unknown): Promise<number> {
  let failed = false;
  const report = async (status: Status, message: string, step?: number) => {
    if (status === "❌") failed = true;
    const fix = step === undefined ? "" : ` 해결: 설정 가이드 ${step}단계 — ${SETUP_GUIDE_URL}#step-${step}`;
    await write(redact(`${status} ${message}${fix}`));
  };
  const failure = (label: string, error: unknown, phase: "refresh" | "chat") => {
    const result = classifyFailure(error, phase);
    return report("❌", `${label}: ${result.message}`, result.step);
  };

  await report("✅", `mailman ${version} — 설정·인증 점검`);
  for (const [label, path, step] of [["설정", paths.configFile, 10], ["클라이언트", paths.clientFile, 8],
    ["토큰", paths.tokenFile, 8], ["DB", paths.dbPath, 10]] as const) {
    let status: Status = "⚠️";
    let detail: string;
    try {
      const info = statSync(path);
      const mode = (info.mode & 0o7777).toString(8).padStart(4, "0");
      status = info.isFile() && mode === "0600" ? "✅" : "⚠️";
      detail = info.isFile() ? `있음, 권한 ${mode}${mode === "0600" ? "" : " — 0600으로 바꾸세요"}` : "일반 파일이 아님";
    } catch (error: unknown) {
      detail = error instanceof Error && "code" in error && error.code === "ENOENT" ? "없음" : "존재 여부·권한 확인 불가";
    }
    // 경로의 제어문자도 한 줄 진단을 깨뜨리지 않도록 이스케이프한다.
    await report(status, `${label} 경로: ${JSON.stringify(path)} (${detail})`, status === "✅" ? undefined : step);
  }

  const noDefault = (reason: string, placeholder = false) => report("⚠️", `설정 파일: 아직 기본 방이 없습니다 (${reason}). 명시 대상(--dm·방 이름)은 설정 없이 동작합니다. mailman spaces <검색어> --save <별칭>으로 등록하세요.${placeholder ? " 기존 예시 설정에서는 --default도 붙여 기본 방을 바꾸세요." : ""}`, 10);
  let config: ReturnType<typeof loadConfig> | undefined;
  try { config = loadConfig(paths.configFile); } catch { /* 아래에서 안전한 고정 문구로 안내한다. */ }
  if (config) {
    const defaultSpace = config.spaces[config.defaultSpace]?.space;
    if (!defaultSpace) await noDefault(existsSync(paths.configFile) ? "defaultSpace 미지정" : "설정 파일 없음");
    else if (/^spaces\/(?:(?:YOUR[_-]?)?SPACE[_-]?ID|A{4,}x+)$/i.test(defaultSpace)) await noDefault("예시 자리표시", true);
    else await report("✅", "설정 파일: JSON·형식 유효, defaultSpace가 spaces에 등록됨.");
  } else {
    let missing = false;
    try { statSync(paths.configFile); }
    catch (error: unknown) { missing = error instanceof Error && "code" in error && error.code === "ENOENT"; }
    if (missing) await noDefault("설정 파일 없음");
    else await report("❌", "설정 파일: JSON·형식 오류 또는 defaultSpace가 spaces에 없음. 설정 파일을 확인하세요.", 10);
  }

  let client: OAuthClient | undefined;
  let clientFailure: "missing" | "web" | "invalid" = "invalid";
  try { client = loadClient(paths.clientFile); }
  catch {
    // 검증 실패 원인은 키의 존재 여부로만 구분하고 파일 내용은 출력하지 않는다.
    try {
      const raw: unknown = JSON.parse(readFileSync(paths.clientFile, "utf8"));
      if (isRecord(raw) && Object.hasOwn(raw, "web")) clientFailure = "web";
    } catch (error: unknown) {
      if (isRecord(error) && error.code === "ENOENT") clientFailure = "missing";
    }
  }
  if (client) await report("✅", "클라이언트 파일: installed(데스크톱 앱) 유형, 필수 필드·인증 주소 유효.");
  else if (clientFailure === "missing") {
    await report("❌", `클라이언트 파일 없음 — 받은 JSON이 있으면 8단계의 mailman auth --client <파일>로 등록하세요. 처음 설정한다면 6단계에서 데스크톱 앱 JSON을 만드세요 (${SETUP_GUIDE_URL}#step-6).`, 8);
  } else if (clientFailure === "web") {
    await report("❌", "클라이언트 파일: web(웹 애플리케이션) 유형은 사용할 수 없습니다. 6단계에서 데스크톱 앱으로 다시 만든 뒤 mailman auth --client <파일>로 등록하세요.", 6);
  } else await report("❌", "클라이언트 파일: JSON·형식 오류. 데스크톱 앱 JSON을 받아 mailman auth --client <파일>로 등록하세요.", 6);

  let token: SavedToken | undefined;
  let tokenError: unknown;
  try { token = loadToken(paths.tokenFile); } catch (error: unknown) { tokenError = error; }
  if (!token) {
    const reason = tokenError instanceof MailmanError && tokenError.message.includes("필수 스코프") ? "필수 스코프가 부족함"
      : tokenError instanceof MailmanError && tokenError.exitCode === 2 ? "토큰 파일이 없음" : "토큰 파일 형식 또는 허용 스코프 오류";
    await report("❌", `토큰: ${reason} — mailman auth를 실행하고 권한을 모두 허용하세요.`, 8);
  } else {
    await report("✅", "토큰: 파일 유효, 필수 스코프 모두 포함.");
    if (token.scopes.includes(REACTION_SCOPE)) await report("✅", "리액션 스코프: 있음.");
    else await report("⚠️", "리액션 스코프 없음 — react만 불가. 필요하면 mailman auth를 다시 실행하세요.", 8);
    if (token.scopes.includes(DIRECTORY_SCOPE)) await report("✅", "디렉터리 검색 스코프: 있음.");
    else await report("⚠️", "디렉터리 검색 스코프 없음 — 등록되지 않은 사람 이름의 회사 디렉터리 검색만 불가. 필요하면 mailman auth를 다시 실행하세요.", 8);
    if (token.scopes.includes(SPACE_CREATE_SCOPE)) await report("✅", "DM 생성 스코프: 있음.");
    else await report("⚠️", "DM 생성 스코프 없음 — 새 DM 생성만 불가. 필요하면 mailman auth를 다시 실행하세요.", 8);
  }

  let accessToken: string | undefined;
  if (!client || !token) await report("⚠️", "토큰 갱신: 건너뜀 — 클라이언트·토큰 점검이 먼저 통과해야 합니다.");
  else {
    let refreshError: unknown;
    try { accessToken = (await refreshAccessToken(client, token, fetcher)).accessToken; }
    catch (error: unknown) { refreshError = error; }
    if (accessToken) await report("✅", "토큰 갱신: 성공.");
    else await failure("토큰 갱신", refreshError, "refresh");
  }
  if (!accessToken || !token) await report("⚠️", "Chat API: 건너뜀 — 토큰 갱신이 먼저 통과해야 합니다.");
  else {
    let hasSpaces: boolean | undefined;
    let chatError: unknown;
    try { hasSpaces = await new ChatClient(accessToken, fetcher).checkSpacesAccess(); }
    catch (error: unknown) { chatError = error; }
    if (hasSpaces !== undefined) await report("✅", `Chat API: 로그인 계정 ${token.email}, ${hasSpaces ? "접근 가능한 스페이스 있음" : "접근 성공 (스페이스 없음 — mailman spaces --refresh로 확인하세요)"}.`);
    else await failure("Chat API", chatError, "chat");
  }
  if (token?.scopes.includes(DIRECTORY_SCOPE)) {
    if (!accessToken || !client) await report("⚠️", "People API: 건너뜀 — 토큰 갱신이 먼저 통과해야 합니다.");
    else {
      let directoryError: unknown;
      try {
        await new ChatClient(accessToken, fetcher).checkDirectoryAccess(token.email.split("@")[0]!);
      } catch (error: unknown) { directoryError = error; }
      if (directoryError) await report("⚠️", `People API (선택): ${directoryErrorMessage(directoryError)}`, 2);
      else await report("✅", "People API (선택): 회사 디렉터리 검색 접근 성공.");
    }
  }
  return failed ? 1 : 0;
}
