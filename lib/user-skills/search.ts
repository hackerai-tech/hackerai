type SearchableSkill = { name: string; description: string };

function normalize(value: string) {
  return value.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

function score(skill: SearchableSkill, query: string): number | null {
  const name = normalize(skill.name);
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(` ${query}`)) return 2;
  if (name.includes(query)) return 3;
  if (normalize(skill.description).includes(query)) return 4;
  // Abbreviations match names only, so long descriptions do not create noise.
  const letters = query.replace(/\s/g, "");
  if (letters.length < 2) return null;
  let next = 0;
  for (const letter of name) {
    if (letter === letters[next]) next++;
    if (next === letters.length) return 5;
  }
  return null;
}

/** Keep picker and library results consistent, with direct names ahead of fuzzy matches. */
export function searchUserSkills<T extends SearchableSkill>(
  skills: readonly T[],
  input: string,
): T[] {
  const query = normalize(input.trim().replace(/^(?:\$|\/skill:)/i, ""));
  if (!query) return [...skills];
  return skills
    .flatMap((skill) => {
      const rank = score(skill, query);
      return rank === null ? [] : [{ skill, rank }];
    })
    .sort((a, b) => a.rank - b.rank || a.skill.name.localeCompare(b.skill.name))
    .map(({ skill }) => skill);
}
