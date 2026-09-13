import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "@jest/globals";

import { SubagentSkillToolHandler } from "../SubagentSkillToolHandler";

describe("SubagentSkillToolHandler", () => {
  it("shows loaded skill names without rendering the full documents", () => {
    render(
      <SubagentSkillToolHandler
        status="ready"
        toolName="load_skill"
        part={{
          toolCallId: "load-1",
          state: "output-available",
          input: {
            skills: ["vulnerabilities/idor", "analysis/source_aware_discovery"],
          },
          output: {
            success: true,
            skills: ["vulnerabilities/idor", "analysis/source_aware_discovery"],
            content: "Full internal methodology that should not be displayed",
          },
        }}
      />,
    );

    expect(screen.getByText("Loaded 2 skills")).toBeVisible();
    expect(screen.getByText("IDOR, Source aware discovery")).toBeVisible();
    expect(
      screen.queryByText(
        "Full internal methodology that should not be displayed",
      ),
    ).not.toBeInTheDocument();
  });

  it("shows a compact search activity without rendering result metadata", () => {
    render(
      <SubagentSkillToolHandler
        status="ready"
        toolName="search_skills"
        part={{
          toolCallId: "search-1",
          state: "output-available",
          input: { query: "authorization" },
          output: {
            success: true,
            results: [
              {
                id: "vulnerabilities/idor",
                description: "Long catalog description",
              },
            ],
          },
        }}
      />,
    );

    expect(screen.getByText("Searched skills")).toBeVisible();
    expect(screen.getByText("authorization")).toBeVisible();
    expect(
      screen.queryByText("Long catalog description"),
    ).not.toBeInTheDocument();
  });
});
