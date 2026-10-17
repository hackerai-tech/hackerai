import { z } from "zod";

const credentials = z
  .object({
    username: z
      .string()
      .min(1)
      .refine((v) => new TextEncoder().encode(v).length <= 255),
    password: z
      .string()
      .refine((v) => new TextEncoder().encode(v).length <= 255),
  })
  .strict();
const input = z
  .object({
    address: z.string().max(260),
    // Omitted: retain credentials for the same endpoint. Null: no authentication.
    credentials: credentials.nullable().optional(),
  })
  .strict();
export type ProxyInput = z.infer<typeof input>;
export type ProxySettings = {
  address: string;
  authenticated: boolean;
  revision: string;
};
export type ProxySecret = {
  address: string;
  username?: string;
  password?: string;
};

export function normalizeProxyInput(value: unknown): ProxyInput {
  const parsed = input.safeParse(value);
  if (!parsed.success)
    throw new Error(
      "Enter a SOCKS5 address and credentials of at most 255 bytes each.",
    );
  const address = parsed.data.address.trim();
  // One unambiguous hostname/IPv4 endpoint. Schemes, userinfo, paths and embedded
  // credentials are never accepted or echoed in validation errors.
  const match = /^([a-zA-Z0-9.-]+):([0-9]{1,5})$/.exec(address);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535)
    throw new Error("Use a SOCKS5 hostname:port or IPv4:port address.");
  const host = match[1].toLowerCase().replace(/\.$/, "");
  if (
    host.length > 253 ||
    !host
      .split(".")
      .every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))
  )
    throw new Error("Use a valid proxy hostname or IPv4 address.");
  if (
    /^[0-9.]+$/.test(host) &&
    (host.split(".").length !== 4 ||
      host
        .split(".")
        .some((part) => Number(part) > 255 || String(Number(part)) !== part))
  )
    throw new Error("Use a canonical IPv4 address for the proxy.");
  return { ...parsed.data, address: `${host}:${Number(match[2])}` };
}
