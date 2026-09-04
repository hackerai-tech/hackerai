import "@testing-library/jest-dom";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UsageLogsTable } from "../UsageLogsTable";

const convexReact = require("convex/react");

class TestBlob {
  readonly content: string;
  readonly type: string;

  constructor(parts: BlobPart[], options?: BlobPropertyBag) {
    this.content = parts.map(String).join("");
    this.type = options?.type || "";
  }
}

const originalBlob = globalThis.Blob;
const originalCreateObjectURL = Object.getOwnPropertyDescriptor(
  URL,
  "createObjectURL",
);
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(
  URL,
  "revokeObjectURL",
);

function restoreUrlProperty(
  key: "createObjectURL" | "revokeObjectURL",
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) {
    Object.defineProperty(URL, key, descriptor);
  } else {
    Reflect.deleteProperty(URL, key);
  }
}

describe("UsageLogsTable", () => {
  beforeEach(() => {
    convexReact.resetMockConvexQueries?.();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "Blob", {
      configurable: true,
      value: originalBlob,
    });
    restoreUrlProperty("createObjectURL", originalCreateObjectURL);
    restoreUrlProperty("revokeObjectURL", originalRevokeObjectURL);
    jest.restoreAllMocks();
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

    expect(screen.getByText("$25.28")).toBeInTheDocument();
    expect(screen.queryByText("$12.04")).not.toBeInTheDocument();
  });

  it("does not show a false component split for legacy mixed rows", () => {
    convexReact.setMockPaginatedQueryResult?.({
      results: [
        {
          _id: "usage-legacy-mixed",
          _creationTime: Date.parse("2026-07-19T15:29:18.000Z"),
          type: "mixed",
          model: "anthropic/claude-opus-4.6",
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
          cost_dollars: 2.5,
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

    expect(screen.getByText("$2.50")).toBeInTheDocument();
    expect(screen.queryByText(/Included \$0\.00/)).not.toBeInTheDocument();
  });

  it("uses the spreadsheet-safe serializer for CSV exports", () => {
    convexReact.setMockPaginatedQueryResult?.({
      results: [
        {
          _id: "usage-export",
          _creationTime: Date.parse("2026-07-19T15:29:18.000Z"),
          type: "included",
          model: "=FORMULA,with comma",
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
          cost_dollars: 1.25,
          included_points_deducted: 1,
          extra_usage_points_deducted: 0,
        },
      ],
      status: "Exhausted",
      loadMore: jest.fn(),
      isLoading: false,
    });
    const createObjectURL = jest.fn(() => "blob:usage-export");
    const revokeObjectURL = jest.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });
    Object.defineProperty(globalThis, "Blob", {
      configurable: true,
      value: TestBlob,
    });
    const anchorClick = jest
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    render(
      <TooltipProvider>
        <UsageLogsTable />
      </TooltipProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Export usage data as CSV" }),
    );

    const exportedBlob = createObjectURL.mock.calls[0]?.[0] as TestBlob;
    expect(exportedBlob.type).toBe("text/csv");
    expect(exportedBlob.content).toContain(
      '"2026-07-19T15:29:18.000Z","Included","\'=FORMULA,with comma"',
    );
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:usage-export");
    expect(anchorClick).toHaveBeenCalledTimes(1);
  });
});
