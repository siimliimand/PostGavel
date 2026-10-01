/**
 * AES-GCM 256 encryption for per-project OpenRouter API keys (plan §3/§5).
 * WebCrypto only — Cloudflare Workers compatible, no Node APIs.
 *
 * Key derivation design (chosen: HKDF, not raw base64 decode):
 * - `ENCRYPTION_KEY` is a Worker secret and is treated as an arbitrary random
 *   *string* (e.g. `openssl rand -base64 32` output), not as raw key bytes.
 *   Requiring base64-decoded 32 bytes would reject (or worse, misinterpret)
 *   secrets that are strong but not exactly base64-of-32-bytes.
 * - We therefore import the UTF-8 secret as HKDF input key material and derive
 *   the actual AES-GCM key with HKDF-SHA-256. Length >= 32 chars is enforced
 *   (fail fast) so weak/missing secrets never silently encrypt.
 * - The HKDF salt is a fixed non-secret constant. Per RFC 5869 §3.3 this is
 *   sound because the input key material is already high-entropy; the constant
 *   additionally domain-separates this derivation from any future use of the
 *   same secret (e.g. a later "session cookie key" would use another salt).
 *   The `info` field names the exact purpose.
 *
 * Storage format: `base64( 12-byte random IV || ciphertext+GCM tag )` — one
 * string column (`project_ai_config.api_key_encrypted`). A fresh random IV is
 * generated per encrypt call (crypto.getRandomValues), so IVs are never reused.
 *
 * This module never logs plaintext or ciphertext, and error messages never
 * include key material.
 */

const MIN_SECRET_LENGTH = 32;
const IV_LENGTH = 12;
const HKDF_SALT = "postgavel:secretbox:salt:v1";
const HKDF_INFO = "postgavel:project-api-key:aes-256-gcm";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

async function deriveKey(secret: string): Promise<CryptoKey> {
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `ENCRYPTION_KEY is missing or too weak (need at least ${MIN_SECRET_LENGTH} characters of entropy). ` +
        `Set it to a random string, e.g. \`openssl rand -base64 32\`.`,
    );
  }
  const ikm = await crypto.subtle.importKey("raw", textEncoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: textEncoder.encode(HKDF_SALT),
      info: textEncoder.encode(HKDF_INFO),
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false, // non-extractable: the raw AES key never leaves WebCrypto
    ["encrypt", "decrypt"],
  );
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encrypt to `base64(iv || ciphertext+tag)`. Throws if the secret is too weak. */
export async function encryptString(plaintext: string, secret: string): Promise<string> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, textEncoder.encode(plaintext)),
  );
  const blob = new Uint8Array(IV_LENGTH + ciphertext.length);
  blob.set(iv, 0);
  blob.set(ciphertext, IV_LENGTH);
  return toBase64(blob);
}

/** Inverse of {@link encryptString}. Throws on weak secret or corrupt blob/keys. */
export async function decryptString(blob: string, secret: string): Promise<string> {
  const key = await deriveKey(secret);
  const bytes = fromBase64(blob);
  if (bytes.length <= IV_LENGTH) throw new Error("Stored secret blob is truncated or corrupt");
  const iv = bytes.slice(0, IV_LENGTH);
  const ciphertext = bytes.slice(IV_LENGTH);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return textDecoder.decode(plaintext);
}

/** UI-safe identifier: last 4 characters only, never the key itself. */
export function apiKeyHint(apiKey: string): string {
  return `…${apiKey.slice(-4)}`;
}
