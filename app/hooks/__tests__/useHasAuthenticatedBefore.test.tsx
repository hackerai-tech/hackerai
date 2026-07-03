import { render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { useHasAuthenticatedBefore } from "../useHasAuthenticatedBefore";
import { hasAuthenticatedBefore } from "@/lib/utils/client-storage";

jest.mock("@/lib/utils/client-storage", () => ({
  hasAuthenticatedBefore: jest.fn(),
}));

const mockHasAuthenticatedBefore =
  hasAuthenticatedBefore as jest.MockedFunction<typeof hasAuthenticatedBefore>;

function AuthHintProbe() {
  return (
    <div data-testid="auth-hint">
      {useHasAuthenticatedBefore() ? "yes" : "no"}
    </div>
  );
}

describe("useHasAuthenticatedBefore", () => {
  beforeEach(() => {
    mockHasAuthenticatedBefore.mockReset();
  });

  it("does not use the browser-only auth hint during server render", () => {
    mockHasAuthenticatedBefore.mockReturnValue(true);

    expect(renderToString(<AuthHintProbe />)).toContain(">no<");
    expect(mockHasAuthenticatedBefore).not.toHaveBeenCalled();
  });

  it("reads the browser auth hint in the client snapshot", async () => {
    mockHasAuthenticatedBefore.mockReturnValue(true);

    render(<AuthHintProbe />);

    await waitFor(() => {
      expect(screen.getByTestId("auth-hint")).toHaveTextContent("yes");
    });
    expect(mockHasAuthenticatedBefore).toHaveBeenCalled();
  });
});
