import { useEffect, useLayoutEffect, useRef } from "react";

export const useLatestRef = <T>(value: T) => {
  const ref = useRef<T>(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
};

/** Keep event and async guards current before child passive effects dispatch. */
export const useCommittedRef = <T>(value: T) => {
  const ref = useRef<T>(value);
  useLayoutEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
};
