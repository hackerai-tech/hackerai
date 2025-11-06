// Simple mock for shiki
export const bundledLanguages = {};
export const bundledLanguagesAlias = {};
export const bundledLanguagesBase = {};
export const bundledLanguagesInfo = [
  { id: "javascript", aliases: ["js"] },
  { id: "typescript", aliases: ["ts"] },
  { id: "python", aliases: ["py"] },
  { id: "bash", aliases: ["sh", "shell"] },
];

export const createHighlighter = jest.fn();
export const getHighlighter = jest.fn();

const mockShiki = {
  bundledLanguages,
  bundledLanguagesAlias,
  bundledLanguagesBase,
  bundledLanguagesInfo,
  createHighlighter,
  getHighlighter,
};

export default mockShiki;
