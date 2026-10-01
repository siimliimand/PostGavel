/**
 * Password hashing with pure WebCrypto (plan §4) — no Node APIs, no native
 * modules, so it runs identically in Workers and in `wrangler dev`.
 *
 * Stored format (PHC-style, one string, self-describing so the iteration count
 * can be raised later without a migration):
 *
 *   pbkdf2-sha256$<iterations>$<salt-base64>$<hash-base64>
 *
 * e.g. `pbkdf2-sha256$100000$c2FsdA==$(32-byte derived key, base64)`.
 * Base64 is the standard padded alphabet (what btoa/Buffer.toString("base64")
 * and Python's base64.b64encode all produce). Salt: 16 random bytes, hash:
 * 32 bytes (256 bits), PBKDF2-SHA256 via crypto.subtle.deriveBits — mirroring
 * Cloudflare's own Workers password-hashing example.
 */

/** Exported so tests/tools can mirror the default cost factor. */
export const PBKDF2_ITERATIONS = 100_000;

const ALGORITHM = "pbkdf2-sha256";
const SALT_BYTES = 16;
const HASH_BYTES = 32;
// Upper sanity bound for a stored iteration count — rejects corrupt values
// before they reach deriveBits (which would happily spin on garbage).
const MAX_ITERATIONS = 10_000_000;

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveBits(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** Constant-time byte comparison: XOR-accumulate, decide once at the end. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false; // length is not secret (hash size is fixed)
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Hash a plaintext password into the storable PHC-style string. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await deriveBits(password, salt, PBKDF2_ITERATIONS);
  return `${ALGORITHM}$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

/**
 * Verify a plaintext password against a stored hash string. Unknown prefixes
 * and corrupt/garbled values return false — never throw — so a legacy or
 * damaged row behaves exactly like a wrong password at login.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split("$");
    if (parts.length !== 4 || parts[0] !== ALGORITHM) return false;
    const iterations = Number(parts[1]);
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS) return false;
    const salt = fromBase64(parts[2]);
    const expected = fromBase64(parts[3]);
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = await deriveBits(password, salt, iterations);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
