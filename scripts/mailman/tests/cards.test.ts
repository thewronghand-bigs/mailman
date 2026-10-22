import { describe, expect, test } from "bun:test";
import { renderCardHtml, renderCards } from "../cards";
import apiCard from "./fixtures/api-card.json";

describe("카드 마크다운 렌더링", () => {
  test("실제 API 스펙 구조의 섹션과 코드 들여쓰기, 엔티티, 오류 서식을 보존한다", () => {
    const expected = [
      "**권한 메뉴 조회 API 명칭 변경**",
      "### **1. 요약**",
      "```\nGET /menus\n\nAuthorization: Bearer STRING\n```",
      "개발계 반영: 내부 이체내역 → 이체내역",
      "### **3. 응답**",
      "**200 OK**",
      '```\n{\n  "message": STRING,\n  "data": { "menus": [] }\n}\n```',
      "### **4. 실패 응답**",
      "**401**  인증 실패\n**403**  권한 없음",
    ].join("\n\n");
    expect(renderCards(JSON.stringify({ cardsV2: [{ cardId: "api-spec", card: apiCard }] }))).toEqual([expected]);
    expect(renderCards(JSON.stringify({ cards: [apiCard] }))).toEqual([expected]);
  });

  test("코드 밖의 서식과 링크를 변환한 뒤 HTML 엔티티를 한 번만 푼다", () => {
    expect(renderCardHtml('<b>굵게</b> <i>기울임</i> <u>밑줄</u> <s>삭제</s> <font color="red">색</font><br/>' +
      '<a href="https://example.test/spec?a=1&amp;b=2"><b>명세</b></a><BR>' +
      '&quot; &amp; &lt; &gt; &#39; &apos; &nbsp; &#65; &#xAC00; &#X1F600; &amp;lt; &unknown;')).toBe(
      '**굵게** _기울임_ 밑줄 삭제 색\n[**명세**](https://example.test/spec?a=1&b=2)\n' +
      '" & < > \' \' \u00a0 A 가 😀 &lt; &unknown;',
    );
    expect(renderCardHtml("<a href='https://example.test/single'>작은따옴표</a> <a href=https://example.test/bare>링크</a>"))
      .toBe("[작은따옴표](https://example.test/single) [링크](https://example.test/bare)");
  });

  test("pre/code의 내용은 엔티티만 풀고 HTML, 공백, 빈 줄을 변환하지 않는다", () => {
    const code = '  <b>원문</b><br><i>문자</i> &lt;tag&gt;\n\n  &quot;키&quot;: &#39;값&#39; &amp;';
    const expected = '```\n  <b>원문</b><br><i>문자</i> <tag>\n\n  "키": \'값\' &\n```';
    for (const html of ["<pre><code>" + code + "</code></pre>", "<pre>" + code + "</pre>", "<code>" + code + "</code>"]) {
      expect(renderCardHtml(html)).toBe(expected);
    }
    expect(renderCardHtml("앞<pre>  들여쓰기\n</pre><b>사이</b><code>둘째</code>뒤"))
      .toBe("앞\n\n```\n  들여쓰기\n```\n\n**사이**\n\n```\n둘째\n```\n\n뒤");
    expect(renderCardHtml("<pre>```\n원문\n```</pre>")).toBe("````\n```\n원문\n```\n````");
  });

  test("레이블, 버튼 링크, columns 재귀, grid, 이미지 설명, 구분선을 순서대로 출력한다", () => {
    const card = {
      header: { title: "위젯", subtitle: "모음" },
      sections: [{ header: "본문", widgets: [
        { decoratedText: { topLabel: "위", text: "<b>중간</b>", bottomLabel: "아래" } },
        { buttonList: { buttons: [
          { text: "<b>명세</b>", onClick: { openLink: { url: "https://example.test/spec?a=1&amp;b=2" } } },
          { text: "동작 버튼", onClick: { action: { function: "ignored" } } },
        ] } },
        { columns: { columnItems: [
          { widgets: [{ textParagraph: { text: "첫 열" } }, { columns: { columnItems: [
            { widgets: [{ textParagraph: { text: "중첩 열" } }] },
          ] } }] },
          { widgets: [{ textParagraph: { text: "둘째 열" } }] },
        ] } },
        { futureWidget: { text: "미지원 위젯의 본문" } },
        { grid: { items: [{ title: "항목 A", subtitle: "설명 A" }, { title: "항목 B" }] } },
        { image: { altText: "설계도 &amp; 설명", imageUrl: "https://example.test/image.png" } },
        { divider: {} },
        { textParagraph: { text: "마지막" } },
      ] }],
    };
    expect(renderCards(JSON.stringify({ cards: [card] }))).toEqual([[
      "**위젯 - 모음**", "### 본문", "위\n**중간**\n아래",
      "[**명세**](https://example.test/spec?a=1&b=2)\n동작 버튼",
      "첫 열", "중첩 열", "둘째 열", "항목 A\n설명 A", "항목 B", "설계도 & 설명", "---", "마지막",
    ].join("\n\n")]);
  });

  test("알 수 없는 위젯과 잘못된 필드/JSON/숫자 엔티티는 크래시 없이 건너뛴다", () => {
    for (const raw of ["{", "null", "[]", '{"cardsV2":true,"cards":42}', '{"cardsV2":[null,{}, {"card":null}]}']) {
      expect(renderCards(raw)).toEqual([]);
    }
    expect(renderCards(JSON.stringify({ cards: [{ header: { title: 42 }, sections: [null, { widgets: [
      null, 1, {}, { unknown: {} }, { textParagraph: { text: false } },
      { decoratedText: { text: [] } }, { buttonList: { buttons: [null, { onClick: null }] } },
      { columns: { columnItems: [null, { widgets: "불량" }] } },
      { grid: { items: [null, { title: {} }] } }, { image: null }, { divider: false },
      { textParagraph: { text: "남은 본문" } },
    ] }] }] }))).toEqual(["남은 본문"]);
    expect(renderCardHtml("&#1114112; &#xD800; &#99999999999999999999999999999;")).toBe("&#1114112; &#xD800; &#99999999999999999999999999999;");
    expect(renderCardHtml(null)).toBe("");
  });
});
