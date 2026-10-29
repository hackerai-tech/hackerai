import type { SVGProps } from "react";

export function GoalTargetIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M21 12a9 9 0 1 1-9-9" />
      <path d="M17 12a5 5 0 1 1-5-5" />
      <path d="M13 14a2 2 0 1 1-3-3" />
      <path d="m12 12 5-5m0-4v4h4l2-2h-4V1z" />
    </svg>
  );
}
