import crypto from "node:crypto";
import { config } from "../config.js";

const PASSCODE_MIN_LENGTH = 6;

/**
 * Shortest passcode that may act as a credential for the API-key bypass. The
 * interactive window scan below only needs PASSCODE_MIN_LENGTH to avoid
 * matching against an empty secret; authorising a request with a guessable
 * code is a different bar, because the limiter allows 30 attempts per minute.
 */
const AUTH_MIN_LENGTH = 8;

const safeEqual = (left, right) => {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

export const bossPasscode = () => String(config.boss.passcode || "").trim();

/** True when the configured passcode is long enough to stand in for an API key. */
export const passcodeCanAuthenticate = () => bossPasscode().length >= AUTH_MIN_LENGTH;

/**
 * Passcode check over the whole message. Every window of the same length is
 * compared with a constant-time comparison and the scan never breaks early, so
 * the check does not leak the position of a correct passcode.
 */
export function containsPasscode(message) {
  const passcode = bossPasscode();
  if (passcode.length < PASSCODE_MIN_LENGTH) return false;
  const haystack = String(message ?? "").toLowerCase();
  const needle = passcode.toLowerCase();
  if (!haystack || needle.length > haystack.length) return false;
  let matched = false;
  for (let index = 0; index + needle.length <= haystack.length; index += 1) {
    if (safeEqual(haystack.slice(index, index + needle.length), needle)) matched = true;
  }
  return matched;
}

export { AUTH_MIN_LENGTH, PASSCODE_MIN_LENGTH };
