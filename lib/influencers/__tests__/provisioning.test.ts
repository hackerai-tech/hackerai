import { partnerProvisioningUrl } from "../provisioning";

it.each([
  "https://hackerai.co",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://[::1]:3000",
])("supports verified HTTPS or local web origins: %s", (base) => {
  expect(partnerProvisioningUrl(base).toString()).toBe(
    `${base}/api/internal/influencers/partners`,
  );
});
it.each([
  "http://hackerai.co",
  "https://user:password@hackerai.co",
  "file:///tmp/test",
  "http://localhost.evil.example",
  "ftp://hackerai.co",
])("does not transmit credentials to unsafe base %s", (base) => {
  expect(() => partnerProvisioningUrl(base)).toThrow();
});
