import { LoaderCircle } from "lucide-react";
import type { JSX } from "react";
interface LoadingProps {
  size?: number;
}

export default function Loading({ size = 12 }: LoadingProps): JSX.Element {
  const sizeClass = `size-${size}`;
  return (
    <div className="flex size-full flex-col items-center justify-center">
      <LoaderCircle className={`mt-4 ${sizeClass} animate-spin`} />
    </div>
  );
}
