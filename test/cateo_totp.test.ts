import { describe, expect, it } from "vitest";

import {
  buildTotpProvisioningUri,
  describeTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  verifyRecoveryCode,
  verifyTotpCode,
} from "../src/cateo/totp.js";

describe("Cateo TOTP", () => {
  it("verifies the RFC 6238 SHA1 test vector", () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(verifyTotpCode(secret, "94287082", { timestampMs: 59000, digits: 8, window: 0 })).toBe(true);
    expect(verifyTotpCode(secret, "94287081", { timestampMs: 59000, digits: 8, window: 0 })).toBe(false);
  });

  it("formats the manual entry key and provisioning URI", () => {
    const secret = "JBSWY3DPEHPK3PXP";
    expect(describeTotpSecret(secret)).toEqual({
      secret,
      manualEntryKey: "JBSW Y3DP EHPK 3PXP",
    });

    const uri = buildTotpProvisioningUri({
      secret,
      accountName: "operator@cateo.org",
      issuer: "Cateo",
    });

    expect(uri).toContain("otpauth://totp/");
    expect(uri).toContain("issuer=Cateo");
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
  });

  it("generates usable recovery codes and invalidates a code after use", () => {
    const codes = generateRecoveryCodes(6);
    expect(codes).toHaveLength(6);
    expect(new Set(codes).size).toBe(6);

    const hashes = codes.map((code) => hashRecoveryCode(code));
    const first = verifyRecoveryCode(codes[0].toLowerCase(), hashes);
    expect(first.valid).toBe(true);
    expect(first.remainingHashes).toHaveLength(5);

    const second = verifyRecoveryCode(codes[0], first.remainingHashes);
    expect(second.valid).toBe(false);
    expect(second.remainingHashes).toHaveLength(5);
  });

  it("generates normalized secrets that can be described safely", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(describeTotpSecret(secret).secret).toBe(secret);
  });
});