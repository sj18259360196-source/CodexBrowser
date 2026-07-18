import assert from "node:assert/strict";
import test from "node:test";
import { canRememberGrant, evaluatePolicy, type PolicyInput } from "../src/browser/policy-engine.ts";

function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    action: "click", tabId: "tab-a", origin: "https://fixture.test", sanitizedUrl: "https://fixture.test/page",
    snapshotRevision: 2, element: { role: "button", type: "button", name: "Apply filter", text: "Apply filter", sensitive: false, isSubmit: false },
    form: { action: "https://fixture.test/search", method: "get", hasSensitiveFields: false, hasPersonalInformation: false, hasFileInput: false, hasSelectedFile: false },
    page: { area: "search", hasPrice: false, hasCurrency: false, heading: "Search", surroundingText: "Filter results" },
    tabState: "READY", assistanceActive: false, grantCategories: [], ...overrides,
  };
}

test("ordinary search, navigation controls, filters, and fills are allowed", () => {
  assert.equal(evaluatePolicy(input()).decision, "allow");
  assert.equal(evaluatePolicy(input({ action: "fill", element: { ...input().element!, role: "textbox", name: "Search query" } })).decision, "allow_redacted");
  assert.equal(evaluatePolicy(input({ element: { ...input().element!, name: "Delete search filter", text: "Delete filter", isSubmit: true }, form: { ...input().form!, method: "post" } })).decision, "allow");
  assert.equal(evaluatePolicy(input({ element: { ...input().element!, name: "Send query", text: "Send query", isSubmit: true }, form: { ...input().form!, method: "post" } })).decision, "allow");
});

test("password, OTP, CAPTCHA, and blocked tabs require manual action", () => {
  for (const name of ["Password", "Enter OTP", "Complete CAPTCHA", "Use passkey"]) {
    assert.equal(evaluatePolicy(input({ element: { ...input().element!, name, sensitive: true } })).decision, "deny_manual");
  }
  assert.equal(evaluatePolicy(input({ tabState: "WAITING_USER" })).decision, "deny_manual");
});

test("ordinary username fields remain fillable beside a password field", () => {
  const decision = evaluatePolicy(input({
    action: "fill",
    element: { role: "textbox", type: "text", name: "University username", sensitive: false, isSubmit: false },
    form: { method: "post", hasSensitiveFields: true, hasPersonalInformation: false, hasFileInput: false, hasSelectedFile: false },
    page: { heading: "Sign in", surroundingText: "Username Password Sign in", hasPrice: false, hasCurrency: false, area: "ordinary" },
  }));
  assert.equal(decision.decision, "allow_redacted");
});

test("sending, publishing, deletion, subscriptions, and orders require confirmation", () => {
  const cases = [
    ["Send message", "communication", "communication"],
    ["Publish article", "publication", "publication"],
    ["Delete record", "deletion", "ordinary"],
    ["Cancel subscription", "subscription", "subscription"],
    ["Place order", "commerce", "checkout"],
  ] as const;
  for (const [name, category, area] of cases) {
    const commerceSignals = category === "commerce" ? { hasPrice: true, hasCurrency: true } : {};
    const policy = evaluatePolicy(input({ element: { ...input().element!, name, text: name, isSubmit: true }, form: { ...input().form!, method: "post" }, page: { ...input().page, area, ...commerceSignals } }));
    assert.equal(policy.decision, "confirm", name);
    assert.equal(policy.category, category, name);
  }
});

test("payment requires a reliable amount summary and never grants broad authorization", () => {
  const missingAmount = evaluatePolicy(input({ element: { ...input().element!, name: "Pay now", isSubmit: true }, page: { ...input().page, area: "checkout" } }));
  assert.equal(missingAmount.decision, "deny_manual");
  const payment = evaluatePolicy(input({ element: { ...input().element!, name: "Pay now", isSubmit: true }, page: { ...input().page, area: "checkout", hasPrice: true, hasCurrency: true } }));
  assert.equal(payment.decision, "confirm");
  assert.equal(payment.category, "payment");
  assert.equal(payment.grantEligible, false);
});

test("approved confirmation and matching grant allow only their requested category", () => {
  const communicationContext = {
    element: { ...input().element!, name: "Send message", text: "Send message", isSubmit: true },
    form: { ...input().form!, method: "post" },
    page: { ...input().page, area: "communication" as const },
  };
  assert.equal(evaluatePolicy(input({ ...communicationContext, tabState: "VERIFYING", requestedCategory: "communication", approvedConfirmation: true })).decision, "allow_redacted");
  assert.equal(evaluatePolicy(input({ ...communicationContext, requestedCategory: "publication", grantCategories: ["publication"] })).decision, "confirm");
  assert.equal(evaluatePolicy(input({ ...communicationContext, requestedCategory: "communication", grantCategories: ["communication"] })).decision, "allow_redacted");
  assert.equal(evaluatePolicy(input({ ...communicationContext, page: { ...communicationContext.page, area: "checkout", hasPrice: false, hasCurrency: false }, element: { ...communicationContext.element, name: "Pay now", text: "Pay now" }, tabState: "VERIFYING", requestedCategory: "payment", approvedConfirmation: true })).decision, "deny_manual");
});

test("upload requires manual selection and then a one-time confirmation", () => {
  const form = { ...input().form!, hasFileInput: true, hasSelectedFile: false };
  const selection = evaluatePolicy(input({ element: { ...input().element!, type: "file" }, form }));
  assert.equal(selection.decision, "deny_manual");
  assert.equal(selection.category, "file_upload");
  const upload = evaluatePolicy(input({ element: { ...input().element!, type: "file" }, form: { ...form, hasSelectedFile: true } }));
  assert.equal(upload.decision, "confirm");
  assert.equal(upload.grantEligible, false);
});

test("account deletion, security, permissions, personal data, and legal terms are guarded", () => {
  const cases: Array<[string, PolicyInput["page"]["area"], string, "confirm" | "deny_manual", Partial<PolicyInput>]> = [
    ["Delete account", "account", "account_security", "confirm", {}],
    ["Change password", "security", "authentication", "deny_manual", {}],
    ["Allow camera", "ordinary", "permission", "confirm", {}],
    ["Submit profile", "ordinary", "personal_information", "confirm", { form: { ...input().form!, method: "post", hasPersonalInformation: true } }],
    ["Accept terms", "ordinary", "legal_terms", "confirm", {}],
  ];
  for (const [name, area, category, decision, overrides] of cases) {
    const policy = evaluatePolicy(input({
      ...overrides,
      element: { ...input().element!, name, text: name, isSubmit: true },
      form: overrides.form || { ...input().form!, method: "post" },
      page: { ...input().page, area },
    }));
    assert.equal(policy.decision, decision, name);
    assert.equal(policy.category, category, name);
  }
});

test("remembered grants never cover authentication or highest-risk categories", () => {
  for (const category of ["authentication", "payment", "account_security", "file_upload", "legal_terms"] as const) {
    assert.equal(canRememberGrant(category), false, category);
  }
  assert.equal(canRememberGrant("communication"), true);
  assert.equal(canRememberGrant("publication"), true);
});
