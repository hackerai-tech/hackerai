import { describe, expect, it } from "@jest/globals";

import { resolveBranchedFromTitle } from "../branchedChatTitle";

describe("resolveBranchedFromTitle", () => {
  const fork = {
    title: "Fork title",
    branched_from_title: "Title when forked",
  };

  it("keeps live titles for a source owned by the viewer", () => {
    expect(
      resolveBranchedFromTitle(
        fork,
        { title: "Current title", user_id: "viewer" },
        "viewer",
      ),
    ).toBe("Current title");
  });

  it("keeps live titles while another user's source remains shared", () => {
    expect(
      resolveBranchedFromTitle(
        fork,
        {
          title: "Current shared title",
          user_id: "owner",
          share_id: "share-1",
          share_date: 1,
        },
        "viewer",
      ),
    ).toBe("Current shared title");
  });

  it("uses the fork-time title after another user's share is revoked", () => {
    expect(
      resolveBranchedFromTitle(
        fork,
        { title: "Private renamed title", user_id: "owner" },
        "viewer",
      ),
    ).toBe("Title when forked");
  });

  it("uses the owned fork title for legacy rows without a title snapshot", () => {
    expect(
      resolveBranchedFromTitle(
        { title: "Legacy fork title" },
        { title: "Private renamed title", user_id: "owner" },
        "viewer",
      ),
    ).toBe("Legacy fork title");
  });
});
