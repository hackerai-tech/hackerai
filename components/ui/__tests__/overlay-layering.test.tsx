import "@testing-library/jest-dom";
import { render } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "@jest/globals";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const expectActionLayer = (container: ParentNode, slot: string) => {
  expect(container.querySelector(`[data-slot="${slot}"]`)).toHaveClass(
    "z-[60]",
  );
};

beforeAll(() => {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverMock,
  });
});

describe("portalled overlay layering", () => {
  it("keeps modal surfaces above workspace drawers", () => {
    const dialog = render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    expectActionLayer(dialog.baseElement, "dialog-overlay");
    expectActionLayer(dialog.baseElement, "dialog-content");
    dialog.unmount();

    const alertDialog = render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>Alert</AlertDialogTitle>
        </AlertDialogContent>
      </AlertDialog>,
    );
    expectActionLayer(alertDialog.baseElement, "alert-dialog-overlay");
    expectActionLayer(alertDialog.baseElement, "alert-dialog-content");
    alertDialog.unmount();

    const sheet = render(
      <Sheet open>
        <SheetContent>
          <SheetTitle>Sheet</SheetTitle>
        </SheetContent>
      </Sheet>,
    );
    expectActionLayer(sheet.baseElement, "sheet-overlay");
    expectActionLayer(sheet.baseElement, "sheet-content");
  });

  it("keeps anchored actions above workspace drawers", () => {
    const menu = render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Action</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    expectActionLayer(menu.baseElement, "dropdown-menu-content");
    menu.unmount();

    const popover = render(
      <Popover open>
        <PopoverTrigger>Open popover</PopoverTrigger>
        <PopoverContent>Popover</PopoverContent>
      </Popover>,
    );
    expectActionLayer(popover.baseElement, "popover-content");
    popover.unmount();

    const tooltip = render(
      <Tooltip open>
        <TooltipTrigger>Open tooltip</TooltipTrigger>
        <TooltipContent>Tooltip</TooltipContent>
      </Tooltip>,
    );
    expectActionLayer(tooltip.baseElement, "tooltip-content");
  });

  it("keeps select menus above workspace drawers", () => {
    const select = render(
      <Select open value="one">
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="one">One</SelectItem>
        </SelectContent>
      </Select>,
    );

    expectActionLayer(select.baseElement, "select-content");
  });
});
