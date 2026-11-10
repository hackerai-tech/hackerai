import { useState } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dialog as WidgetDialog, Theme } from "@radix-ui/themes";
import { Dialog, DialogContent, DialogTitle } from "../dialog";

function SettingsWithSecurityWidget() {
  const [verification, setVerification] = useState(false);
  return (
    <Dialog defaultOpen>
      <DialogContent>
        <DialogTitle>Settings</DialogTitle>
        <Theme>
          <WidgetDialog.Root>
            <WidgetDialog.Trigger>
              <button>Set up authenticator app</button>
            </WidgetDialog.Trigger>
            <WidgetDialog.Content>
              <WidgetDialog.Title>Verify your identity</WidgetDialog.Title>
              <WidgetDialog.Description>
                Confirm your email
              </WidgetDialog.Description>
              {verification ? (
                <input aria-label="Verification code" />
              ) : (
                <button onClick={() => setVerification(true)}>Send code</button>
              )}
              <WidgetDialog.Close>
                <button>Cancel verification</button>
              </WidgetDialog.Close>
            </WidgetDialog.Content>
          </WidgetDialog.Root>
        </Theme>
      </DialogContent>
    </Dialog>
  );
}

it("lets an embedded security dialog retain code-entry focus and return it on cancel", async () => {
  const user = userEvent.setup();
  render(<SettingsWithSecurityWidget />);
  await user.click(
    screen.getByRole("button", { name: "Set up authenticator app" }),
  );
  await user.click(screen.getByRole("button", { name: "Send code" }));
  const verification = screen.getByRole("dialog", {
    name: "Verify your identity",
  });
  const input = within(verification).getByRole("textbox", {
    name: "Verification code",
  });
  await user.click(input);
  expect(input).toHaveFocus();
  await user.keyboard("123");
  expect(input).toHaveValue("123");
  await user.click(
    within(verification).getByRole("button", { name: "Cancel verification" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Set up authenticator app" }),
    ).toHaveFocus(),
  );
  expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
});
