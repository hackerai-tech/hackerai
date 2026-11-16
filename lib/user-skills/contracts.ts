export const USER_SKILLS_FLAG = "private-user-skills";
export const MAX_USER_SKILLS = 32;
export const MAX_SELECTED_SKILLS = 3;
export const MAX_SKILL_BYTES = 16 * 1024;
export const MAX_LOADED_SKILL_BYTES = 32 * 1024;
export type SkillDraft = { name: string; description: string; content: string };
export const utf8Bytes = (text: string) =>
  new TextEncoder().encode(text).length;

export function validateSkill(draft: SkillDraft): SkillDraft {
  const name = draft.name.trim();
  const description = draft.description.trim();
  const content = draft.content.trim();
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name))
    throw new Error("Use a name between 1 and 80 characters.");
  if (description.length > 240 || /[\u0000-\u001f\u007f]/.test(description))
    throw new Error("Use a single-line description up to 240 characters.");
  if (
    !content ||
    utf8Bytes(content) > MAX_SKILL_BYTES ||
    content.includes("\0")
  )
    throw new Error("Methodology must be nonempty Markdown up to 16 KiB.");
  return { name, description, content };
}

// Only plain Markdown and a small interoperable frontmatter subset. Never parse
// YAML tags, follow links, download references, or execute embedded commands.
export function importSkill(text: string, filename: string): SkillDraft {
  if (!/\.md$/i.test(filename))
    throw new Error("Upload a Markdown (.md) file.");
  if (utf8Bytes(text) > MAX_SKILL_BYTES + 1024 || text.includes("\0"))
    throw new Error("Upload a UTF-8 Markdown file up to 17 KiB.");
  let content = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  let name = filename.replace(/\.md$/i, "");
  let description = "";
  if (content.startsWith("---\n")) {
    const end = content.indexOf("\n---\n", 4);
    if (end < 0)
      throw new Error("Close frontmatter with a line containing ---.");
    for (const line of content.slice(4, end).split("\n")) {
      const match = /^(name|description):\s*(.*)$/.exec(line);
      if (!match) continue;
      let value = match[2].trim();
      if (value.startsWith('"')) {
        try {
          value = JSON.parse(value);
        } catch {
          throw new Error("Use plain text or JSON-quoted frontmatter values.");
        }
      } else if (value.startsWith("'") && value.endsWith("'"))
        value = value.slice(1, -1).replaceAll("''", "'");
      if (typeof value !== "string") throw new Error("Invalid skill metadata.");
      if (match[1] === "name") name = value;
      else description = value;
    }
    content = content.slice(end + 5);
  }
  return validateSkill({ name, description, content });
}
export function exportSkill(draft: SkillDraft): string {
  const skill = validateSkill(draft);
  return `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.content}\n`;
}
