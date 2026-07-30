let counter = 0;

export const v4 = () => {
  counter++;
  return `test-uuid-${counter}`;
};

function stableHex(value: string): string {
  let hash = 2166136261;
  let result = "";
  for (let chunk = 0; chunk < 4; chunk += 1) {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index) + chunk;
      hash = Math.imul(hash, 16777619);
    }
    result += (hash >>> 0).toString(16).padStart(8, "0");
  }
  return result;
}

export const v5 = Object.assign(
  (value: string, namespace: string) => {
    const hex = stableHex(`${namespace}:${value}`);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(
      13,
      16,
    )}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  },
  {
    DNS: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    URL: "6ba7b811-9dad-11d1-80b4-00c04fd430c8",
  },
);

export const validate = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );

const mockUuid = {
  v4,
  v5,
  validate,
};

export default mockUuid;
