import { resolvePendingInfluencerReferral } from "../pending-referral";

function browser(href = "https://hackerai.co/?ref=medusa") {
  return {
    location: { href, replace: jest.fn() },
  } as unknown as Pick<Window, "location">;
}

describe("pending influencer consent", () => {
  it("leaves the pending URL untouched before a decision", () => {
    const tab = browser();
    resolvePendingInfluencerReferral(tab, null);
    expect(tab.location.replace).not.toHaveBeenCalled();
  });

  it("resumes through the validated short link after acceptance", () => {
    const tab = browser("https://hackerai.co/?ref=Medusa");
    resolvePendingInfluencerReferral(tab, "accepted");
    expect(tab.location.replace).toHaveBeenCalledWith("/r/medusa");
  });

  it("discards only the pending code on rejection", () => {
    const tab = browser("https://hackerai.co/?ref=medusa&utm_source=x#pricing");
    resolvePendingInfluencerReferral(tab, "declined");
    expect(tab.location.replace).toHaveBeenCalledWith("/?utm_source=x#pricing");
  });

  it.each([
    "",
    "?ref=",
    "?ref=//evil.example",
    "?ref=../signup",
    "?ref=javascript:alert(1)",
  ])(
    "never navigates for absent or invalid referral parameters: %s",
    (search) => {
      const tab = browser(`https://hackerai.co/${search}`);
      resolvePendingInfluencerReferral(tab, "accepted");
      expect(tab.location.replace).not.toHaveBeenCalled();
    },
  );
});
