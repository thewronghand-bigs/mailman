import type { Database } from "bun:sqlite";
import { DIRECTORY_SCOPE, loadToken, requireSpaceCreateScope } from "./auth";
import { MAX_SPACE_MEMBERS, type ChatClient } from "./chat";
import { errorMessage, MailmanError } from "./errors";
import { formatPerson, formatSpace, rememberPerson, resolveChatPerson, saveAlias, type ResolvedChatPerson } from "./resolve";
import { loadConfig, type RuntimePaths } from "./runtime";
import { cacheSpace, registeredPeople } from "./store";

type Options = { displayName: string; members: string[]; save?: string; makeDefault?: boolean; dryRun?: boolean };

export async function createSpace(db: Database, client: () => Promise<ChatClient>, paths: Pick<RuntimePaths, "configFile" | "tokenFile">,
  options: Options, selfUser: () => Promise<string>, out: (text: string) => unknown, now = new Date()): Promise<void> {
  const config = loadConfig(paths.configFile);
  if (options.save !== undefined && Object.hasOwn(config.spaces, options.save)) {
    throw new MailmanError(`이미 등록된 별칭입니다: ${options.save}. --save는 덮어쓰지 않습니다.`);
  }
  const resolved: { argument: string; person: ResolvedChatPerson }[] = [];
  for (const argument of options.members) {
    try {
      resolved.push({ argument, person: await resolveChatPerson(db, client, argument,
        { directoryEnabled: () => loadToken(paths.tokenFile).scopes.includes(DIRECTORY_SCOPE) }, now) });
    } catch (error: unknown) {
      throw new MailmanError(`--member ${JSON.stringify(argument)}: ${errorMessage(error)}`, error instanceof MailmanError ? error.exitCode : 1);
    }
  }
  // 리터럴은 추가 조회하지 않는다. 이미 아는 이메일·ID만 연결해 같은 사람을 합친다.
  const known = [...registeredPeople(db), ...resolved.flatMap(({ person }) => person.registration ? [person.registration] : [])];
  const token = loadToken(paths.tokenFile);
  const members = new Map<string, { userName: string; displayName: string; email: string | null; argument: string }>();
  for (const { argument, person } of resolved) {
    const aliases = new Map(known.filter(candidate => candidate.userName === person.userName ||
      person.userName.includes("@") && candidate.email && `users/${candidate.email.toLowerCase()}` === person.userName.toLowerCase())
      .map(candidate => [candidate.userName, candidate]));
    if (aliases.size > 1) throw new MailmanError(`--member ${JSON.stringify(argument)}: 이메일이 일치하는 후보가 여러 명입니다. users/ID로 지정하세요.\n${[...aliases.values()].map(formatPerson).join("\n")}`);
    const knownPerson = [...aliases.values()][0];
    const member = { userName: knownPerson?.userName ?? person.userName, displayName: knownPerson?.displayName ?? person.displayName,
      email: knownPerson?.email ?? null, argument };
    if (member.userName === "users/me" || member.userName.toLowerCase() === `users/${token.email.toLowerCase()}` || member.email?.toLowerCase() === token.email.toLowerCase()) {
      throw new MailmanError(`--member ${JSON.stringify(argument)}: 본인 계정은 지정할 수 없습니다. 호출자는 자동 멤버입니다.`);
    }
    const key = member.userName.includes("@") ? member.userName.toLowerCase() : member.userName;
    members.set(key, member);
  }
  if (!members.size || members.size > MAX_SPACE_MEMBERS) throw new MailmanError(`멤버는 1~${MAX_SPACE_MEMBERS}명 지정하세요.`);
  const self = token.user_name ?? await selfUser();
  for (const member of members.values()) {
    if (member.userName === self) throw new MailmanError(`--member ${JSON.stringify(member.argument)}: 본인 계정은 지정할 수 없습니다. 호출자는 자동 멤버입니다.`);
  }
  const invited = `${options.dryRun ? "초대할" : "초대한"} 멤버 (${members.size}명):\n${[...members.values()].map(formatPerson).join("\n")}`;
  if (options.dryRun) {
    await out(`[스페이스 생성 미리보기]\n표시 이름: ${options.displayName}\n${invited}${options.save !== undefined ? `\n[별칭] ${options.save}: ${options.makeDefault ? "기본 방으로 지정할 예정" : "저장할 예정"} (미리보기이므로 설정 변경 없음)` : ""}`);
    return;
  }
  requireSpaceCreateScope(paths.tokenFile);
  const space = await (await client()).setupSpace(options.displayName, [...members.values()].map(member => member.userName));
  const summary = `✅ 스페이스 생성 완료\n${formatSpace(space)}\n${invited}`;
  try {
    db.transaction(() => {
      cacheSpace(db, space, now.toISOString());
      for (const { person } of resolved) rememberPerson(db, person);
    })();
    if (options.save !== undefined) saveAlias(paths.configFile, options.save, space.name, { makeDefault: options.makeDefault });
    await out(`${summary}${options.save !== undefined ? `\n[별칭] ${options.save}: ${options.makeDefault ? "기본 방으로 지정했습니다." : "저장했습니다."}` : ""}`);
  } catch (error: unknown) {
    throw new MailmanError(`${summary}\n스페이스는 이미 생성됨 — 재생성하지 말 것. 로컬 저장/출력 실패: ${errorMessage(error)}`,
      error instanceof MailmanError ? error.exitCode : 1);
  }
}
