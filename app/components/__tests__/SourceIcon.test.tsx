import { fireEvent, render } from "@testing-library/react";
import { SourceIcon } from "../SourceIcon";

it("falls back after image failure and can load a different public source", () => {
  const { container, rerender } = render(
    <SourceIcon url="https://owasp.org/private?token=secret" />,
  );
  const image = container.querySelector("img")!;
  expect(image).toHaveAttribute(
    "src",
    "https://www.google.com/s2/favicons?domain=owasp.org&sz=32",
  );
  expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
  fireEvent.error(image);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");

  rerender(<SourceIcon url="https://github.com/path" />);
  expect(container.querySelector("img")).toHaveAttribute(
    "src",
    "https://www.google.com/s2/favicons?domain=github.com&sz=32",
  );

  rerender(<SourceIcon url="https://grafana.internal.example.com/" />);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("svg")).toBeInTheDocument();
});
