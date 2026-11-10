import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, scryptSync } from "node:crypto";
import { createLocalJWKSet, jwtVerify } from "jose";
import { checkPassword, publicJwks, readSession, signSession } from "./session.ts";
import { shouldUseAgentLongForAgent } from "../chat/agent-routing.ts";
import { requireVercelChatMode } from "../api/chat-request-validation.ts";
import { getMaxTokensForSubscription } from "../token-limits.ts";

test("local password, signed session, expiry, tampering and password rotation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hackerai-auth-test-"));
  const previous = { ...process.env };
  try {
    const keys = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    await writeFile(join(directory, "private.pem"), keys.privateKey, {
      mode: 0o600,
    });
    await writeFile(join(directory, "public.pem"), keys.publicKey);
    process.env.LOCAL_AUTH_KEY_DIR = directory;
    process.env.NEXT_PUBLIC_BASE_URL = "https://test.invalid";
    process.env.LOCAL_AUTH_EMAIL = "admin@test.invalid";
    const salt = "0123456789abcdef";
    process.env.LOCAL_AUTH_PASSWORD_HASH = `${salt}:${scryptSync("local-test-password", salt, 64).toString("hex")}`;
    assert.equal(
      await checkPassword("ADMIN@test.invalid", "local-test-password"),
      true,
    );
    assert.equal(
      await checkPassword("admin@test.invalid", "wrong-password"),
      false,
    );
    assert.equal(
      await checkPassword("other@test.invalid", "local-test-password"),
      false,
    );
    assert.equal(await readSession(undefined), null);
    const token = await signSession();
    assert.equal((await readSession(token))?.user.email, "admin@test.invalid");
    const [head, body, signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body, "base64url").toString()),
        sub: "attacker",
      }),
    ).toString("base64url");
    assert.equal(await readSession(`${head}.${forged}.${signature}`), null);
    assert.equal(await readSession(await signSession(undefined, "-1s")), null);
    const verified = await jwtVerify(
      token,
      createLocalJWKSet(await publicJwks()),
      { issuer: "https://test.invalid", audience: "hackerai-vps" },
    );
    assert.equal(verified.payload.sub, "user_vps_admin");
    await assert.rejects(
      jwtVerify(token, createLocalJWKSet(await publicJwks()), {
        issuer: "https://other.invalid",
      }),
    );
    process.env.LOCAL_AUTH_PASSWORD_HASH = "new-password-version";
    assert.equal(await readSession(token), null);
  } finally {
    process.env = previous;
    await rm(directory, { recursive: true });
  }
});

test("VPS runs Agent through the shared stream runner while hosted routing stays unchanged", () => {
  const previous = process.env.NEXT_PUBLIC_SELF_HOSTED;
  try {
    process.env.NEXT_PUBLIC_SELF_HOSTED = "true";
    assert.equal(
      shouldUseAgentLongForAgent({ mode: "agent", isTauri: false }),
      false,
    );
    assert.equal(requireVercelChatMode("agent"), "agent");
    assert.equal(requireVercelChatMode("ask"), "ask");
    assert.throws(() => requireVercelChatMode("bogus"));
    assert.equal(getMaxTokensForSubscription("ultra"), 8192);
    process.env.NEXT_PUBLIC_SELF_HOSTED = "false";
    assert.equal(
      shouldUseAgentLongForAgent({ mode: "agent", isTauri: false }),
      true,
    );
    assert.throws(() => requireVercelChatMode("agent"));
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_SELF_HOSTED;
    else process.env.NEXT_PUBLIC_SELF_HOSTED = previous;
  }
});
