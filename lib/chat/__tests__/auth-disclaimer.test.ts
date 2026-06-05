import { describe, expect, it } from "@jest/globals";
import { detectLang } from "../auth-disclaimer";

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
});
