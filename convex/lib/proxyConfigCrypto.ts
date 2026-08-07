"use node";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const ENCRYPTION_VERSION = 1;

type EncryptedProxyEnvelope = {
  version: number;
  iv: string;
  authTag: string;
  ciphertext: string;
};

export type StoredProxyConfig = {
  host: string;
  port: number;
  username?: string;
  password?: string;
  proxyDns: boolean;
  bypassHosts: string[];
};

function parseEncryptionKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32) {
    throw new Error(
      "USER_PROXY_CONFIG_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
    );
  }
  return key;
}

function getAdditionalAuthenticatedData(userId: string): Buffer {
  return Buffer.from(`hackerai:user-proxy-config:v1:${userId}`, "utf8");
}

export function encryptProxyConfig(
  config: StoredProxyConfig,
  userId: string,
  encodedKey: string,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, parseEncryptionKey(encodedKey), iv);
  cipher.setAAD(getAdditionalAuthenticatedData(userId));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(config), "utf8"),
    cipher.final(),
  ]);

  const envelope: EncryptedProxyEnvelope = {
    version: ENCRYPTION_VERSION,
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };

  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

export function decryptProxyConfig(
  encrypted: string,
  userId: string,
  encodedKey: string,
): StoredProxyConfig {
  const envelope = JSON.parse(
    Buffer.from(encrypted, "base64").toString("utf8"),
  ) as EncryptedProxyEnvelope;
  if (envelope.version !== ENCRYPTION_VERSION) {
    throw new Error("Unsupported proxy configuration encryption version");
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    parseEncryptionKey(encodedKey),
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAAD(getAdditionalAuthenticatedData(userId));
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");

  return JSON.parse(plaintext) as StoredProxyConfig;
}
