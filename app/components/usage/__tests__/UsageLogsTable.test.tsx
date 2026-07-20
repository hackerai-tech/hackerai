import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UsageLogsTable } from "../UsageLogsTable";

const convexReact = require("convex/react");

describe("UsageLogsTable", () => {
  beforeEach(() => {
    convexReact.resetMockConvexQueries?.();
  });

  it("shows the amount deducted from extra-usage credits in the Cost column", () => {
    convexReact.setMockPaginatedQueryResult?.({
      results: [
        {
          _id: "usage-1",
          _creationTime: Date.parse("2026-07-19T15:29:18.000Z"),
          type: "extra",
          model: "anthropic/claude-opus-4.6",
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
          cost_dollars: 12.037878597222221,
          extra_usage_cost_dollars: 12.037878597222221,
          included_points_deducted: 0,
          extra_usage_points_deducted: 168_531,
        },
      ],
      status: "Exhausted",
      loadMore: jest.fn(),
      isLoading: false,
    });

    render(
      <TooltipProvider>
        <UsageLogsTable />
      </TooltipProvider>,
    );

    expect(screen.getByText("$19.38")).toBeInTheDocument();
    expect(screen.queryByText("$12.04")).not.toBeInTheDocument();
  });
});
