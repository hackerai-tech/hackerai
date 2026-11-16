import { searchUserSkills } from "../search";

const skills = [
  { name: "Report", description: "Include an API review summary" },
  { name: "Application permissions inventory", description: "Roles" },
  { name: "API review extended", description: "Additional checks" },
  { name: "API review", description: "Authorization methodology" },
];

it("ranks exact and prefix names above description and abbreviation matches", () => {
  expect(searchUserSkills(skills, "API review").map((s) => s.name)).toEqual([
    "API review",
    "API review extended",
    "Report",
  ]);
  expect(searchUserSkills(skills, "API").map((s) => s.name)).toEqual([
    "API review",
    "API review extended",
    "Report",
    "Application permissions inventory",
  ]);
});

it("accepts copied shortcuts, name separators, and case-insensitive abbreviations", () => {
  expect(searchUserSkills(skills, "  /skill:API_review  ")[0]).toBe(skills[3]);
  expect(searchUserSkills(skills, "$api-review")[0]).toBe(skills[3]);
  expect(searchUserSkills(skills, "APREVW").map((s) => s.name)).toEqual([
    "API review",
    "API review extended",
  ]);
});

it("preserves empty-query ordering and distinct skills with the same name", () => {
  expect(searchUserSkills(skills, " ")).toEqual(skills);
  const duplicate = { ...skills[3], description: "Different workflow" };
  expect(searchUserSkills([skills[3], duplicate], "API review")).toEqual([
    skills[3],
    duplicate,
  ]);
  expect(searchUserSkills(skills, "zzzz")).toEqual([]);
});
