async (page) => {
  return await page.evaluate(() => {
    const results = [];
    const seen = new Set();
    const allGroups = Array.from(document.querySelectorAll("div[role='group']"));

    const leafGroups = allGroups.filter((group) => {
      const childGroups = group.querySelectorAll("div[role='group']");
      if (childGroups.length === 0) return true;
      return Array.from(childGroups).every((childGroup) => childGroup.innerText?.trim() === "");
    });

    for (const group of leafGroups) {
      const heading = group.querySelector("[data-message-id][role='heading']");
      if (!heading) continue;

      const id = heading.getAttribute("data-message-id");
      if (!id || seen.has(id)) continue;
      seen.add(id);

      let threadName = null;
      let parent = group.parentElement;
      while (parent) {
        if (parent.tagName === "C-WIZ" && parent.getAttribute("data-topic-id")) {
          threadName = parent.getAttribute("data-topic-id");
          break;
        }
        parent = parent.parentElement;
      }

      let createTime = new Date().toISOString();
      const timestampElement = group.querySelector("[data-absolute-timestamp]");
      if (timestampElement) {
        const raw = Number(timestampElement.getAttribute("data-absolute-timestamp"));
        if (Number.isFinite(raw) && raw > 0) {
          createTime = new Date(raw).toISOString();
        }
      }

      const headingText = heading.innerText ?? "";
      const headingLines = headingText.split("\n").map((line) => line.trim()).filter(Boolean);
      const senderDisplayName = headingLines[0] || "(unknown)";
      const text = (group.innerText ?? "").trim();
      if (!text) continue;

      results.push({
        id,
        threadName,
        createTime,
        senderDisplayName,
        text
      });
    }

    return results;
  });
}
