import "@testing-library/jest-dom";
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import UpgradeConfirmationDialog from "../UpgradeConfirmationDialog";

// Mock fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe("UpgradeConfirmationDialog", () => {
  const defaultProps = {
    isOpen: true,
    onClose: jest.fn(),
    planName: "Team",
    price: 80,
    targetPlan: "team-monthly-plan",
    quantity: 2,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
  });

  describe("Loading state", () => {
    it("should show loading spinner while fetching details", () => {
      mockFetch.mockImplementation(() => new Promise(() => {})); // Never resolves

      render(<UpgradeConfirmationDialog {...defaultProps} />);

      // Check for the spinner animation class
      expect(document.querySelector(".animate-spin")).toBeInTheDocument();
    });
  });

  describe("Seat count display", () => {
    it("should display seat count when quantity > 1", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            proratedAmount: 80,
            proratedCredit: 10,
            totalDue: 70,
            paymentMethod: "VISA *4242",
            currentPlan: "pro",
            quantity: 3,
            currentPeriodStart:
              Math.floor(Date.now() / 1000) - 15 * 24 * 60 * 60,
            currentPeriodEnd: Math.floor(Date.now() / 1000) + 15 * 24 * 60 * 60,
          }),
      });

      render(<UpgradeConfirmationDialog {...defaultProps} quantity={3} />);

      await waitFor(() => {
        expect(screen.getByText(/3 seats/i)).toBeInTheDocument();
      });
    });

    it("should NOT display seat count when quantity is 1", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            proratedAmount: 20,
            proratedCredit: 0,
            totalDue: 20,
            paymentMethod: "VISA *4242",
            currentPlan: "free",
            quantity: 1,
          }),
      });

      render(<UpgradeConfirmationDialog {...defaultProps} quantity={1} />);

      await waitFor(() => {
        expect(screen.getByText(/Team subscription/i)).toBeInTheDocument();
      });

      expect(screen.queryByText(/seats/i)).not.toBeInTheDocument();
    });
  });

  describe("Proration display", () => {
    it("should show proration credit from Pro plan", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            proratedAmount: 80,
            proratedCredit: 10,
            totalDue: 70,
            paymentMethod: "VISA *4242",
            currentPlan: "pro",
            quantity: 2,
          }),
      });

      render(<UpgradeConfirmationDialog {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText("Proration credit")).toBeInTheDocument();
        expect(screen.getByText("-$10.00")).toBeInTheDocument();
      });
    });

    it("should display total due correctly", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            proratedAmount: 80,
            proratedCredit: 10,
            totalDue: 70,
            paymentMethod: "VISA *4242",
            currentPlan: "pro",
            quantity: 2,
          }),
      });

      render(<UpgradeConfirmationDialog {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText("$70.00")).toBeInTheDocument();
      });
    });
  });

  describe("API calls", () => {
    it("should pass quantity to preview API", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            proratedAmount: 160,
            proratedCredit: 10,
            totalDue: 150,
            paymentMethod: "VISA *4242",
            currentPlan: "pro",
            quantity: 5,
          }),
      });

      render(<UpgradeConfirmationDialog {...defaultProps} quantity={5} />);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          "/api/subscription-details",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({
              plan: "team-monthly-plan",
              confirm: false,
              quantity: 5,
            }),
          }),
        );
      });
    });

    it("should pass quantity to confirm API on payment confirmation", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              proratedAmount: 80,
              proratedCredit: 10,
              totalDue: 70,
              paymentMethod: "VISA *4242",
              currentPlan: "pro",
              quantity: 2,
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });

      render(<UpgradeConfirmationDialog {...defaultProps} quantity={2} />);

      // Wait for preview to load
      await waitFor(() => {
        expect(screen.getByText("$70.00")).toBeInTheDocument();
      });

      // Click confirm button
      const confirmButton = screen.getByRole("button", {
        name: /confirm and pay/i,
      });
      fireEvent.click(confirmButton);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenLastCalledWith(
          "/api/subscription-details",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({
              plan: "team-monthly-plan",
              confirm: true,
              quantity: 2,
            }),
          }),
        );
      });
    });
  });

  describe("Error handling", () => {
    it("should display error message on API failure", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              proratedAmount: 80,
              proratedCredit: 10,
              totalDue: 70,
              paymentMethod: "VISA *4242",
              currentPlan: "pro",
              quantity: 2,
            }),
        })
        .mockResolvedValueOnce({
          ok: false,
          json: () => Promise.resolve({ error: "Payment method declined" }),
        });

      render(<UpgradeConfirmationDialog {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText("$70.00")).toBeInTheDocument();
      });

      const confirmButton = screen.getByRole("button", {
        name: /confirm and pay/i,
      });
      fireEvent.click(confirmButton);

      await waitFor(() => {
        expect(screen.getByText("Payment method declined")).toBeInTheDocument();
      });
    });
  });

  describe("Cancel button", () => {
    it("should call onClose when cancel button is clicked", async () => {
      const mockOnClose = jest.fn();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            proratedAmount: 80,
            proratedCredit: 10,
            totalDue: 70,
            paymentMethod: "VISA *4242",
            currentPlan: "pro",
            quantity: 2,
          }),
      });

      render(
        <UpgradeConfirmationDialog {...defaultProps} onClose={mockOnClose} />,
      );

      await waitFor(() => {
        expect(screen.getByText("$70.00")).toBeInTheDocument();
      });

      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      fireEvent.click(cancelButton);

      expect(mockOnClose).toHaveBeenCalled();
    });
  });
});
