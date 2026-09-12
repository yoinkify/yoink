import { logEvent } from "@/lib/logger";
import { createHash } from "crypto";

interface PowSolution {
  challenge: string;
  nonce: number;
  hash: string;
  timestamp: number;
}

const DIFFICULTY = 16;
// Mobile browsers throttle background tabs, so PoW solves can stretch past a
// minute when the user switches apps. The replay cache still bounds reuse, so
// the age window can be generous without weakening the check.
const MAX_AGE_MS = 300_000;
const MAX_CLOCK_SKEW_MS = 120_000;

// Track used challenges to prevent replay
const usedChallenges = new Set<string>();

// Clean up old challenges every 5 minutes
setInterval(() => {
  usedChallenges.clear();
}, 5 * 60_000);

export function verifyProofOfWork(solution: PowSolution): boolean {
  // Check age
  const age = Date.now() - solution.timestamp;
  if (age > MAX_AGE_MS || age < -MAX_CLOCK_SKEW_MS) {
    logEvent("proof-of-work-verify.rejected_age");
    return false;
  }

  // Check replay
  const key = `${solution.challenge}:${solution.nonce}`;
  if (usedChallenges.has(key)) {
    logEvent("proof-of-work-verify.rejected_replay");
    return false;
  }

  // Verify hash
  const input = `${solution.challenge}:${solution.nonce}`;
  const hash = createHash("sha256").update(input).digest("hex");
  if (hash !== solution.hash) {
    logEvent("proof-of-work-verify.rejected_hash_mismatch");
    return false;
  }

  // Verify difficulty
  const hashBuffer = Buffer.from(hash, "hex");
  if (!hasLeadingZeroBits(hashBuffer, DIFFICULTY)) {
    logEvent("proof-of-work-verify.rejected_difficulty_not_met");
    return false;
  }

  // Mark as used
  usedChallenges.add(key);
  return true;
}

function hasLeadingZeroBits(hash: Buffer, bits: number): boolean {
  const fullBytes = Math.floor(bits / 8);
  const remainingBits = bits % 8;

  for (let i = 0; i < fullBytes; i++) {
    if (hash[i] !== 0) return false;
  }

  if (remainingBits > 0) {
    const mask = 0xff << (8 - remainingBits);
    if ((hash[fullBytes] & mask) !== 0) return false;
  }

  return true;
}
