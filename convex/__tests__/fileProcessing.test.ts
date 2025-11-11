/**
 * Tests for File Processing
 *
 * @module convex/__tests__/fileProcessing.test.ts
 * @jest-environment node
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { processFileAuto } from "../fileProcessing";
import { MAX_TOKENS_FILE } from "../../lib/token-utils";
import { countTokens } from "gpt-tokenizer";
import { getDocument } from "pdfjs-serverless";
import { CSVLoader } from "@langchain/community/document_loaders/fs/csv";
import mammoth from "mammoth";
import WordExtractor from "word-extractor";
import { isBinaryFile } from "isbinaryfile";

jest.mock("../../lib/utils/file-utils", () => ({
  isSupportedImageMediaType: jest.fn((mediaType: string) => {
    return (
      mediaType === "image/png" ||
      mediaType === "image/jpeg" ||
      mediaType === "image/gif" ||
      mediaType === "image/webp"
    );
  }),
}));

describe("fileProcessing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset countTokens to default behavior
    (countTokens as jest.Mock).mockImplementation((text: string) => Math.ceil(text.length / 4));
  });
  describe("processFileAuto - Text Files", () => {
    it("should process plain text files", async () => {
      const textContent = "Hello, World!";
      const blob = new Blob([textContent], { type: "text/plain" });
      const result = await processFileAuto(blob, "test.txt");

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe(textContent);
      expect(result[0].tokens).toBeGreaterThan(0);
    });

    it("should process markdown files without prepend", async () => {
      const markdownContent = "# Hello\n\nThis is markdown.";
      const blob = new Blob([markdownContent], { type: "text/markdown" });
      const result = await processFileAuto(blob, "test.md");

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe(markdownContent);
      expect(result[0].tokens).toBeGreaterThan(0);
    });

    it("should process markdown files with prepend text", async () => {
      const markdownContent = "# Content";
      const prependText = "Prepended text";
      const blob = new Blob([markdownContent], { type: "text/markdown" });
      const result = await processFileAuto(blob, "test.md", undefined, prependText);

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe(`${prependText}\n\n${markdownContent}`);
      expect(result[0].tokens).toBeGreaterThan(0);
    });

    it("should handle empty prepend text for markdown", async () => {
      const markdownContent = "# Content";
      const blob = new Blob([markdownContent], { type: "text/markdown" });
      const result = await processFileAuto(blob, "test.md", undefined, "");

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe(markdownContent);
    });
  });

  describe("processFileAuto - JSON Files", () => {
    it("should process valid JSON files", async () => {
      const jsonData = { key: "value", nested: { data: 123 } };
      const blob = new Blob([JSON.stringify(jsonData)], {
        type: "application/json",
      });
      const result = await processFileAuto(blob, "test.json");

      expect(result).toHaveLength(1);
      // JSON should be formatted with indentation
      expect(result[0].content).toBe(JSON.stringify(jsonData, null, 2));
      expect(result[0].tokens).toBeGreaterThan(0);
    });

    it("should handle JSON files with compact formatting", async () => {
      const jsonData = { compact: true };
      const compactJson = '{"compact":true}';
      const blob = new Blob([compactJson], { type: "application/json" });
      const result = await processFileAuto(blob, "test.json");

      expect(result).toHaveLength(1);
      // Should be reformatted with indentation
      expect(result[0].content).toBe(JSON.stringify(jsonData, null, 2));
    });

    it("should handle invalid JSON with fallback to empty content", async () => {
      const invalidJson = "{ invalid json }";
      const blob = new Blob([invalidJson], { type: "application/json" });

      // Invalid JSON should fall back to returning empty content
      const result = await processFileAuto(blob, "test.json");
      expect(result).toHaveLength(1);
      expect(result[0].tokens).toBe(0);
    });
  });

  describe("processFileAuto - CSV Files", () => {
    it("should process CSV files using CSVLoader", async () => {
      const mockCsvContent = "name,age\nJohn,30\nJane,25";

      // Mock CSVLoader instance
      const mockLoad = jest.fn().mockResolvedValue([
        { pageContent: "name: John, age: 30" },
        { pageContent: "name: Jane, age: 25" },
      ]);

      (CSVLoader as jest.Mock).mockImplementation(() => ({
        load: mockLoad,
      }));

      const blob = new Blob([mockCsvContent], { type: "text/csv" });
      const result = await processFileAuto(blob, "test.csv");

      expect(result).toHaveLength(1);
      expect(result[0].content).toContain("John");
      expect(result[0].content).toContain("Jane");
      expect(result[0].tokens).toBeGreaterThan(0);
      expect(mockLoad).toHaveBeenCalled();
    });
  });

  describe("processFileAuto - PDF Files", () => {
    it("should process PDF files using pdfjs", async () => {
      const mockPage1 = {
        getTextContent: jest.fn().mockResolvedValue({
          items: [
            { str: "Hello" },
            { str: "from" },
            { str: "page" },
            { str: "1" },
          ],
        }),
      };

      const mockPage2 = {
        getTextContent: jest.fn().mockResolvedValue({
          items: [{ str: "Page" }, { str: "2" }, { str: "content" }],
        }),
      };

      const mockDoc = {
        numPages: 2,
        getPage: jest.fn()
          .mockResolvedValueOnce(mockPage1)
          .mockResolvedValueOnce(mockPage2),
      };

      (getDocument as jest.Mock).mockReturnValue({
        promise: Promise.resolve(mockDoc),
      });

      const pdfBuffer = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF signature
      const blob = new Blob([pdfBuffer], { type: "application/pdf" });
      const result = await processFileAuto(blob, "test.pdf");

      expect(result).toHaveLength(1);
      expect(result[0].content).toContain("Hello from page 1");
      expect(result[0].content).toContain("Page 2 content");
      expect(result[0].tokens).toBeGreaterThan(0);
      expect(mockDoc.getPage).toHaveBeenCalledTimes(2);
    });
  });

  describe("processFileAuto - DOCX Files", () => {
    it("should process DOCX files using mammoth", async () => {
      const mockDocxContent = "This is a Word document content.";

      (mammoth.extractRawText as jest.Mock).mockResolvedValue({
        value: mockDocxContent,
      });

      const docxBuffer = Buffer.from([0x50, 0x4b]); // ZIP signature for docx
      const blob = new Blob([docxBuffer], {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
      const result = await processFileAuto(blob, "test.docx");

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe(mockDocxContent);
      expect(result[0].tokens).toBeGreaterThan(0);
      expect(mammoth.extractRawText).toHaveBeenCalled();
    });

    it("should process legacy DOC files using word-extractor", async () => {
      const mockDocContent = "This is a legacy Word document.";

      const mockExtracted = {
        getBody: jest.fn().mockReturnValue(mockDocContent),
      };

      const mockExtract = jest.fn().mockResolvedValue(mockExtracted);
      (WordExtractor as jest.Mock).mockImplementation(() => ({
        extract: mockExtract,
      }));

      const docBuffer = Buffer.from([0xd0, 0xcf]); // DOC signature
      const blob = new Blob([docBuffer], { type: "application/msword" });
      const result = await processFileAuto(blob, "test.doc");

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe(mockDocContent);
      expect(result[0].tokens).toBeGreaterThan(0);
      expect(mockExtract).toHaveBeenCalled();
    });
  });

  describe("processFileAuto - Image Files", () => {
    it("should return 0 tokens for supported image formats", async () => {
      const imageTypes = [
        { type: "image/png", filename: "test.png" },
        { type: "image/jpeg", filename: "test.jpg" },
        { type: "image/gif", filename: "test.gif" },
        { type: "image/webp", filename: "test.webp" },
      ];

      for (const { type, filename } of imageTypes) {
        const blob = new Blob(["fake image data"], { type });
        const result = await processFileAuto(blob, filename, type);

        expect(result).toHaveLength(1);
        expect(result[0].content).toBe("");
        expect(result[0].tokens).toBe(0);
      }
    });
  });

  describe("processFileAuto - Unknown/Binary Files", () => {
    it("should handle unknown file types with binary content", async () => {
      (isBinaryFile as jest.Mock).mockResolvedValue(true);

      const blob = new Blob([Buffer.from([0x00, 0x01, 0x02])], {
        type: "application/octet-stream",
      });
      const result = await processFileAuto(blob, "unknown.bin");

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe("");
      expect(result[0].tokens).toBe(0);
      expect(isBinaryFile).toHaveBeenCalled();
    });

    it("should process unknown file types as text if not binary", async () => {
      (isBinaryFile as jest.Mock).mockResolvedValue(false);

      const textContent = "This is plain text";
      const blob = new Blob([textContent], { type: "application/unknown" });
      const result = await processFileAuto(blob, "unknown.xyz");

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe(textContent);
      expect(result[0].tokens).toBeGreaterThan(0);
      expect(isBinaryFile).toHaveBeenCalled();
    });
  });

  describe("processFileAuto - Token Validation", () => {
    it("should throw error when file exceeds token limit", async () => {
      // Mock token count to exceed limit
      (countTokens as jest.Mock).mockReturnValue(MAX_TOKENS_FILE + 1000);

      const largeContent = "a".repeat(100000);
      const blob = new Blob([largeContent], { type: "text/plain" });

      await expect(processFileAuto(blob, "large.txt")).rejects.toThrow(
        /exceeds the maximum token limit/
      );
    });

    it("should skip token validation when skipTokenValidation is true", async () => {
      (countTokens as jest.Mock).mockReturnValue(MAX_TOKENS_FILE + 1000);

      const largeContent = "a".repeat(100000);
      const blob = new Blob([largeContent], { type: "text/plain" });

      // Should not throw with skipTokenValidation = true
      const result = await processFileAuto(blob, "large.txt", undefined, undefined, true);

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe(largeContent);
    });

    it("should pass validation for files within token limit", async () => {
      (countTokens as jest.Mock).mockReturnValue(1000);

      const normalContent = "Normal sized content";
      const blob = new Blob([normalContent], { type: "text/plain" });

      const result = await processFileAuto(blob, "normal.txt");

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe(normalContent);
      expect(result[0].tokens).toBe(1000);
    });
  });

  describe("processFileAuto - File Type Detection", () => {
    it("should detect file type by MIME type", async () => {
      const content = "Test content";
      const testCases = [
        { type: "application/pdf", extension: "pdf" },
        { type: "text/csv", extension: "csv" },
        { type: "application/json", extension: "json" },
        { type: "text/plain", extension: "txt" },
        { type: "text/markdown", extension: "md" },
      ];

      for (const { type } of testCases) {
        const blob = new Blob([content], { type });
        // Should not throw - file type detected successfully
        await expect(processFileAuto(blob, `test.${type.split('/')[1]}`)).resolves.toBeDefined();
      }
    });

    it("should detect file type by extension when MIME type is missing", async () => {
      const content = "Test content";
      const blob = new Blob([content]); // No MIME type

      const result = await processFileAuto(blob, "test.txt");

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe(content);
    });

    it("should handle files with markdown extension variations", async () => {
      const content = "# Markdown";

      // Test both .md and .markdown extensions
      const extensions = ["test.md", "test.markdown"];

      for (const filename of extensions) {
        const blob = new Blob([content], { type: "text/markdown" });
        const result = await processFileAuto(blob, filename);

        expect(result).toHaveLength(1);
        expect(result[0].content).toBe(content);
      }
    });

    it("should handle docx vs doc distinction", async () => {
      // Mock both extractors
      (mammoth.extractRawText as jest.Mock).mockResolvedValue({
        value: "DOCX content",
      });

      const mockExtracted = {
        getBody: jest.fn().mockReturnValue("DOC content"),
      };
      const mockExtract = jest.fn().mockResolvedValue(mockExtracted);
      (WordExtractor as jest.Mock).mockImplementation(() => ({
        extract: mockExtract,
      }));

      // Test .docx
      const docxBlob = new Blob([Buffer.from([0x50, 0x4b])], {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
      await processFileAuto(docxBlob, "test.docx");
      expect(mammoth.extractRawText).toHaveBeenCalled();

      jest.clearAllMocks();

      // Test .doc
      const docBlob = new Blob([Buffer.from([0xd0, 0xcf])], {
        type: "application/msword",
      });
      await processFileAuto(docBlob, "test.doc");
      expect(mockExtract).toHaveBeenCalled();
    });
  });

  describe("processFileAuto - Error Handling", () => {
    it("should handle PDF processing errors with fallback", async () => {
      (getDocument as jest.Mock).mockReturnValue({
        promise: Promise.reject(new Error("PDF parsing failed")),
      });

      const blob = new Blob(["fake pdf"], { type: "application/pdf" });

      // Should fall back to returning empty content
      const result = await processFileAuto(blob, "corrupted.pdf");

      expect(result).toHaveLength(1);
      expect(result[0].tokens).toBe(0);
    });

    it("should handle text file processing with text/* MIME type fallback", async () => {
      const textContent = "Fallback text content";
      const blob = new Blob([textContent], { type: "text/custom" });

      const result = await processFileAuto(blob, "custom.txt");

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe(textContent);
    });

    it("should return 0 tokens for failed non-text files", async () => {
      (getDocument as jest.Mock).mockReturnValue({
        promise: Promise.reject(new Error("PDF parsing failed")),
      });

      const blob = new Blob(["corrupted data"], { type: "application/pdf" });
      const result = await processFileAuto(blob, "corrupted.pdf");

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe("");
      expect(result[0].tokens).toBe(0);
    });

    it("should not suppress token limit errors in error handling", async () => {
      // Make PDF parsing fail
      (getDocument as jest.Mock).mockReturnValue({
        promise: Promise.reject(new Error("PDF parsing failed")),
      });

      // Make fallback text processing exceed token limit
      (countTokens as jest.Mock).mockReturnValue(MAX_TOKENS_FILE + 1000);

      const blob = new Blob(["large corrupted pdf"], { type: "text/plain" });

      // Should throw token limit error, not suppress it
      await expect(processFileAuto(blob, "large.txt", "text/plain")).rejects.toThrow(
        /exceeds the maximum token limit/
      );
    });
  });

  describe("processFileAuto - Edge Cases", () => {
    it("should handle empty files", async () => {
      const blob = new Blob([""], { type: "text/plain" });
      const result = await processFileAuto(blob, "empty.txt");

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe("");
      expect(result[0].tokens).toBe(0);
    });

    it("should handle files with only whitespace", async () => {
      const whitespaceContent = "   \n\t  \n   ";
      const blob = new Blob([whitespaceContent], { type: "text/plain" });
      const result = await processFileAuto(blob, "whitespace.txt");

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe(whitespaceContent);
    });

    it("should handle unicode content", async () => {
      const unicodeContent = "Hello 世界 🌍 مرحبا";
      const blob = new Blob([unicodeContent], { type: "text/plain" });
      const result = await processFileAuto(blob, "unicode.txt");

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe(unicodeContent);
      expect(result[0].tokens).toBeGreaterThan(0);
    });

    it("should handle files without extension", async () => {
      const content = "Content without extension";
      const blob = new Blob([content], { type: "text/plain" });
      const result = await processFileAuto(blob, "README");

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe(content);
    });

    it("should handle files with multiple dots in name", async () => {
      const content = "Test content";
      const blob = new Blob([content], { type: "text/plain" });
      const result = await processFileAuto(blob, "my.backup.file.txt");

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe(content);
    });

    it("should handle case-insensitive file extensions", async () => {
      const content = "# Markdown";
      const blob = new Blob([content], { type: "text/markdown" });

      const uppercaseResult = await processFileAuto(blob, "test.MD");
      const mixedResult = await processFileAuto(blob, "test.Md");

      expect(uppercaseResult[0].content).toBe(content);
      expect(mixedResult[0].content).toBe(content);
    });
  });

  describe("processFileAuto - Return Type Validation", () => {
    it("should always return array of FileItemChunk", async () => {
      const blob = new Blob(["test"], { type: "text/plain" });
      const result = await processFileAuto(blob, "test.txt");

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);

      const chunk = result[0];
      expect(chunk).toHaveProperty("content");
      expect(chunk).toHaveProperty("tokens");
      expect(typeof chunk.content).toBe("string");
      expect(typeof chunk.tokens).toBe("number");
    });

    it("should have valid token counts", async () => {
      const blob = new Blob(["test content"], { type: "text/plain" });
      const result = await processFileAuto(blob, "test.txt");

      expect(result[0].tokens).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(result[0].tokens)).toBe(true);
    });
  });
});
