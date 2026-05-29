import { describe, expect, it } from "@jest/globals";
import { getMessageActionVisibility } from "../MessageActions";

const baseVisibilityInput = {
  isUser: false,
  isLastAssistantMessage: true,
  isMobile: false,
  isHovered: false,
  isEditing: false,
  isLastAssistantLoading: false,
  hasTimestamp: true,
};

describe("getMessageActionVisibility", () => {
  it("keeps the last assistant actions visible and reserves timestamp space", () => {
    expect(getMessageActionVisibility(baseVisibilityInput)).toEqual({
      shouldRenderActions: true,
      actionsAreVisible: true,
      shouldReserveTimestamp: true,
      timestampIsVisible: false,
    });
  });

  it("shows historical assistant actions only on desktop hover", () => {
    expect(
      getMessageActionVisibility({
        ...baseVisibilityInput,
        isLastAssistantMessage: false,
      }),
    ).toEqual({
      shouldRenderActions: true,
      actionsAreVisible: false,
      shouldReserveTimestamp: true,
      timestampIsVisible: false,
    });

    expect(
      getMessageActionVisibility({
        ...baseVisibilityInput,
        isLastAssistantMessage: false,
        isHovered: true,
      }),
    ).toEqual({
      shouldRenderActions: true,
      actionsAreVisible: true,
      shouldReserveTimestamp: true,
      timestampIsVisible: true,
    });
  });

  it("shows user actions only on desktop hover with timestamp first", () => {
    expect(
      getMessageActionVisibility({
        ...baseVisibilityInput,
        isUser: true,
        isLastAssistantMessage: false,
      }),
    ).toMatchObject({
      shouldRenderActions: true,
      actionsAreVisible: false,
      shouldReserveTimestamp: true,
    });

    expect(
      getMessageActionVisibility({
        ...baseVisibilityInput,
        isUser: true,
        isLastAssistantMessage: false,
        isHovered: true,
      }),
    ).toEqual({
      shouldRenderActions: true,
      actionsAreVisible: true,
      shouldReserveTimestamp: true,
      timestampIsVisible: true,
    });
  });

  it("keeps actions visible and timestamp hidden on mobile", () => {
    expect(
      getMessageActionVisibility({
        ...baseVisibilityInput,
        isUser: true,
        isLastAssistantMessage: false,
        isMobile: true,
      }),
    ).toEqual({
      shouldRenderActions: true,
      actionsAreVisible: true,
      shouldReserveTimestamp: false,
      timestampIsVisible: false,
    });
  });

  it("suppresses actions while editing or while the last assistant is loading", () => {
    expect(
      getMessageActionVisibility({
        ...baseVisibilityInput,
        isEditing: true,
      }),
    ).toEqual({
      shouldRenderActions: false,
      actionsAreVisible: false,
      shouldReserveTimestamp: false,
      timestampIsVisible: false,
    });

    expect(
      getMessageActionVisibility({
        ...baseVisibilityInput,
        isLastAssistantLoading: true,
      }),
    ).toEqual({
      shouldRenderActions: false,
      actionsAreVisible: false,
      shouldReserveTimestamp: false,
      timestampIsVisible: false,
    });
  });
});
