import assert from "node:assert/strict";
import test from "node:test";
import {
  sanitizeError,
  sanitizeSensitiveText,
  sanitizeUrlForExposure,
} from "../src/security/redaction.ts";

const markers = [
  "Mars-31Aa!",
  "Earth-32Bb!",
  "Venus-33Cc!",
  "Neptune-34Dd!",
  "Uranus-35Ee!",
  "Pluto-36Ff!",
  "Ceres-37Gg!",
  "Haumea-38Hh!",
];

function assertMarkersRemoved(value: string | undefined): void {
  assert.equal(markers.some((marker) => value?.includes(marker)), false);
}

test("redacts sensitive assignments used by fields, logs, and errors", () => {
  const sanitized = sanitizeSensitiveText([
    `password=${markers[0]}`,
    `pin-code: ${markers[1]}`,
    `recovery_code=${markers[2]}`,
    `csrf=${markers[3]}`,
    `hidden=${markers[4]}`,
    `filepath=${markers[5]}`,
    `captcha=${markers[6]}`,
    `api_key=${markers[7]}`,
  ].join(" "));

  assertMarkersRemoved(sanitized);
  assert.match(sanitized || "", /\[REDACTED\]/);
});

test("removes credentials and query data from exposed URLs", () => {
  const sanitized = sanitizeUrlForExposure("https://user:pass@example.test/private/path?token=Mars-31Aa!#fragment");
  assert.equal(sanitized, "https://example.test/");
  assertMarkersRemoved(sanitized);
});

test("drops arbitrary paths and ordinary query keys that may carry field values", () => {
  const sanitized = sanitizeUrlForExposure(`https://example.test/search/${markers[0]}?q=${markers[1]}`);
  assert.equal(sanitized, "https://example.test/");
  assertMarkersRemoved(sanitized);
});

test("sanitizes URL and authorization material embedded in text", () => {
  const sanitized = sanitizeSensitiveText(
    `Open https://example.test/callback?code=${markers[0]} with Bearer ${markers[1]}`,
  );
  assertMarkersRemoved(sanitized);
  assert.equal(sanitized?.includes("?"), false);
});

test("sanitizes errors and normalizes unsafe error names", () => {
  const error = new Error(`hidden=${markers[4]}`);
  error.name = "page supplied name";
  const sanitized = sanitizeError(error);
  assert.equal(sanitized.name, "BROWSER_ERROR");
  assertMarkersRemoved(sanitized.message);
});
