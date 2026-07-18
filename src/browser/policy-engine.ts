import type { BrowserAction, BrowserTabState } from "../shared/contracts";

export type PolicyDecision = "allow" | "allow_redacted" | "confirm" | "deny_manual";
export type ActionRiskCategory =
  | "ordinary"
  | "authentication"
  | "communication"
  | "publication"
  | "deletion"
  | "commerce"
  | "payment"
  | "subscription"
  | "account_security"
  | "permission"
  | "file_upload"
  | "personal_information"
  | "legal_terms";

export interface PolicyElementContext {
  role: string;
  type?: string;
  name: string;
  text?: string;
  sensitive: boolean;
  href?: string;
  isSubmit: boolean;
}

export interface PolicyFormContext {
  action?: string;
  method?: string;
  hasSensitiveFields: boolean;
  hasPersonalInformation: boolean;
  hasFileInput: boolean;
  hasSelectedFile: boolean;
}

export interface PolicyPageContext {
  heading?: string;
  surroundingText?: string;
  hasPrice: boolean;
  hasCurrency: boolean;
  area: "ordinary" | "search" | "account" | "security" | "subscription" | "checkout" | "communication" | "publication";
}

export interface PolicyInput {
  action: BrowserAction["action"];
  tabId: string;
  origin: string;
  sanitizedUrl: string;
  snapshotRevision?: number;
  element?: PolicyElementContext;
  form?: PolicyFormContext;
  page: PolicyPageContext;
  targetOrigin?: string;
  tabState: BrowserTabState;
  assistanceActive: boolean;
  grantCategories: ActionRiskCategory[];
  requestedCategory?: ActionRiskCategory;
  approvedConfirmation?: boolean;
}

export interface PolicyResult {
  decision: PolicyDecision;
  category: ActionRiskCategory;
  ruleId: string;
  summary: string;
  impact: string;
  grantEligible: boolean;
  requiresAmountCheck?: boolean;
}

const authentication = /password|passcode|one.?time|otp|verification code|recovery code|captcha|turnstile|webauthn|passkey|windows hello|certificate|验证码|密码|动态码|恢复码|人机验证/i;
const communication = /send|message|mail|reply|comment|contact|submit feedback|发送|回复|评论|留言|私信|邮件/i;
const publication = /publish|post|upload and publish|make public|发布|公开|发表|投稿/i;
const deletion = /delete|remove|erase|destroy|永久删除|删除|移除|清空/i;
const commerce = /place order|submit order|buy now|purchase|checkout|order|提交订单|立即购买|结账|购买/i;
const payment = /pay|payment|charge|confirm purchase|付款|支付|扣款/i;
const subscription = /subscribe|unsubscribe|cancel plan|cancel service|subscription|订阅|退订|取消服务/i;
const security = /change password|reset password|mfa|two.factor|security setting|账户安全|修改密码|重置密码|双重验证/i;
const permission = /allow camera|allow microphone|location permission|notification permission|grant access|摄像头|麦克风|位置权限|通知权限|授予权限/i;
const legal = /accept terms|agree and continue|sign agreement|contract|接受条款|同意协议|签署|合同/i;
const personal = /full name|address|phone|date of birth|identity|passport|身份证|住址|手机号|出生日期|个人信息/i;

function combined(input: PolicyInput): string {
  return [input.element?.name, input.element?.text, input.element?.type, input.page.heading, input.page.surroundingText].filter(Boolean).join(" ").slice(0, 2_000);
}

function result(decision: PolicyDecision, category: ActionRiskCategory, ruleId: string, summary: string, impact: string, grantEligible = false, requiresAmountCheck = false): PolicyResult {
  return { decision, category, ruleId, summary, impact, grantEligible, requiresAmountCheck: requiresAmountCheck || undefined };
}

function authorizeConfirmed(input: PolicyInput, policy: PolicyResult): PolicyResult {
  if (policy.decision !== "confirm") return policy;
  if (input.approvedConfirmation && input.requestedCategory === policy.category) {
    return result("allow_redacted", policy.category, "confirmation.revalidated", "已重新验证的一次性操作", policy.impact, false, Boolean(policy.requiresAmountCheck));
  }
  if (input.grantCategories.includes(policy.category) && policy.grantEligible) {
    return result("allow_redacted", policy.category, "grant.scoped", "使用当前网站的临时授权", policy.impact, policy.grantEligible, Boolean(policy.requiresAmountCheck));
  }
  return policy;
}

export function evaluatePolicy(input: PolicyInput): PolicyResult {
  const words = combined(input);
  const elementWords = [input.element?.name, input.element?.text, input.element?.type].filter(Boolean).join(" ");
  const submit = input.element?.isSubmit === true;
  const mutating = !["hover", "focus", "scroll"].includes(input.action);
  if (!mutating) return result("allow", "ordinary", "ordinary.passive", "普通页面操作", "不会提交或修改外部数据");
  if (input.assistanceActive || input.element?.sensitive || submit && input.form?.hasSensitiveFields || authentication.test(elementWords)) {
    return result("deny_manual", "authentication", "sensitive.manual", "敏感认证操作", "需要用户在可见浏览器中手工完成");
  }
  const revalidatingConfirmation = input.approvedConfirmation && input.tabState === "VERIFYING";
  if (!revalidatingConfirmation && ["WAITING_USER", "VERIFYING", "PAUSED_BY_USER", "CLOSED"].includes(input.tabState)) {
    return result("deny_manual", "authentication", "tab.blocked", "标签页当前由用户控制", "自动操作保持冻结");
  }
  if (input.element?.type === "file" || input.form?.hasFileInput) {
    if (!input.form?.hasSelectedFile) return result("deny_manual", "file_upload", "upload.selection_required", "选择上传文件", "需要用户明确选择文件");
    return authorizeConfirmed(input, result("confirm", "file_upload", "upload.confirm", "上传用户选择的文件", "文件将发送到当前网站"));
  }
  if (security.test(elementWords) || submit && input.page.area === "security") {
    return authorizeConfirmed(input, result("confirm", "account_security", "security.confirm_once", "修改账户安全设置", "可能改变账户访问或验证方式"));
  }
  if (permission.test(words)) return authorizeConfirmed(input, result("confirm", "permission", "permission.confirm", "修改网站权限", "网站将获得或失去浏览器权限"));
  if (input.page.area === "search" && (deletion.test(words) || communication.test(words))) {
    return result("allow", "ordinary", "ordinary.search_control", "普通搜索或筛选操作", "只调整当前搜索或筛选条件");
  }
  if (payment.test(words)) {
    if (!input.page.hasPrice || !input.page.hasCurrency) return result("deny_manual", "payment", "payment.amount_unknown", "付款金额无法可靠确认", "需要用户手工检查金额和货币");
    return authorizeConfirmed(input, result("confirm", "payment", "payment.confirm_once", "发起付款或购买", "将按页面显示的金额和货币产生交易", false, true));
  }
  if (commerce.test(words) && submit) return authorizeConfirmed(input, result("confirm", "commerce", "commerce.order_confirm", "提交订单或购买请求", "可能创建订单或购买义务"));
  if (subscription.test(words) && submit) return authorizeConfirmed(input, result("confirm", "subscription", "subscription.confirm", "修改或取消订阅", "将改变持续服务或费用", true));
  if (deletion.test(words) && submit && input.page.area !== "search") {
    const account = /account|账户/.test(words) || input.page.area === "account";
    return authorizeConfirmed(input, result("confirm", account ? "account_security" : "deletion", account ? "account.delete_confirm_once" : "delete.confirm", account ? "删除账户" : "删除外部记录或内容", "操作可能不可逆", !account));
  }
  if (publication.test(words) && submit) return authorizeConfirmed(input, result("confirm", "publication", "publish.confirm", "发布或公开内容", "内容将对外部用户可见", true));
  if (communication.test(words) && submit && input.page.area !== "search") {
    return authorizeConfirmed(input, result("confirm", "communication", "communication.confirm", "发送消息或提交评论", "内容将发送到外部系统", true));
  }
  if (legal.test(words) && submit) return authorizeConfirmed(input, result("confirm", "legal_terms", "legal.confirm_once", "接受具有法律含义的条款", "可能形成协议或合同义务"));
  if (input.form?.hasPersonalInformation && submit || personal.test(words) && submit) {
    return authorizeConfirmed(input, result("confirm", "personal_information", "personal_data.confirm", "提交个人信息", "个人信息将发送到当前网站", true));
  }
  if (submit && input.form?.method?.toLowerCase() === "post") return authorizeConfirmed(input, result("confirm", "personal_information", "submit.uncertain", "提交外部表单", "页面上下文不足，需确认后执行"));
  return result(input.action === "fill" ? "allow_redacted" : "allow", "ordinary", input.action === "fill" ? "ordinary.fill_redacted" : "ordinary.action", "普通网页操作", "不会产生已识别的高风险外部影响");
}

export function canRememberGrant(category: ActionRiskCategory): boolean {
  return !["ordinary", "authentication", "payment", "account_security", "file_upload", "legal_terms"].includes(category);
}
