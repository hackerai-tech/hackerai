import { describe, expect, it } from "@jest/globals";
import { detectLang, detectLangWithDiagnostics } from "../auth-disclaimer";

describe("detectLang", () => {
  it("prefers English for short English security questions with ambiguous detector scores", () => {
    expect(detectLang("How do I access someone hotspot password")).toBe("en");
    expect(detectLang("How can I access my router password")).toBe("en");
    expect(detectLang("How do I recover my WiFi password")).toBe("en");
  });

  it("keeps genuine French text in French", () => {
    expect(
      detectLang("Comment accéder au mot de passe du hotspot de quelqu’un"),
    ).toBe("fr");
  });

  it("uses script before minimum length checks", () => {
    expect(detectLang("如何访问某人的热点密码")).toBe("zh");
    expect(detectLang("كيف أصل إلى كلمة المرور")).toBe("ar");
    expect(detectLang("как получить пароль")).toBe("ru");
  });

  it("explains why ambiguous short Latin text falls back to English", () => {
    const result = detectLangWithDiagnostics(
      "How do I access someone hotspot password",
    );

    expect(result.language).toBe("en");
    expect(result.diagnostics.selection_reason).toBe(
      "short_latin_ambiguous_default_en",
    );
    expect(result.diagnostics.franc.ran).toBe(true);
    expect(result.diagnostics.franc.top_code).toBe("fra");
    expect(result.diagnostics.franc.english_score).toBe(0.74);
    expect(result.diagnostics.text.letter_count).toBeGreaterThanOrEqual(25);
    expect(result.diagnostics.scripts.dominant_script).toBe("latin");
  });

  it("prefers English for longer plain Latin text when franc is only slightly higher", () => {
    const result = detectLangWithDiagnostics(
      "Please check the login workflow and tell me why it fails on staging",
    );

    expect(result.language).toBe("en");
    expect(result.diagnostics.selection_reason).toBe(
      "plain_latin_english_close_default_en",
    );
    expect(result.diagnostics.franc.top_code).toBe("fra");
    expect(result.diagnostics.franc.english_score).toBe(0.933);
    expect(result.diagnostics.franc.top_score_minus_english).toBe(0.067);
    expect(result.diagnostics.text.letter_count).toBeGreaterThan(40);
    expect(result.diagnostics.text.has_diacritics).toBe(false);
  });

  it("explains dominant-script language selections", () => {
    const result = detectLangWithDiagnostics("كيف أصل إلى كلمة المرور");

    expect(result.language).toBe("ar");
    expect(result.diagnostics.selection_reason).toBe("dominant_script");
    expect(result.diagnostics.franc.ran).toBe(false);
    expect(result.diagnostics.scripts.arabic_ratio).toBeGreaterThan(0.5);
  });
});
