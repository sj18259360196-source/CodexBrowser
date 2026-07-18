import { randomUUID } from "node:crypto";
import type { BrowserDataAction, BrowserDataConfirmation } from "../shared/contracts";

interface StoredConfirmation extends BrowserDataConfirmation { used: boolean; includePermissions: boolean; }

function confirmationError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

export class BrowserDataConfirmationStore {
  private readonly items = new Map<string, StoredConfirmation>();

  request(action: BrowserDataAction, scope: string, includePermissions = false, now = Date.now()): BrowserDataConfirmation {
    const titles: Record<BrowserDataAction, string> = {
      clear_site: "清除当前网站数据",
      clear_all: "清除全部 Codex Browser 浏览数据",
      reset_profile: "重置专用浏览器 Profile",
    };
    const details: Record<BrowserDataAction, string> = {
      clear_site: `将退出 ${scope} 的登录并删除该网站的 Cookie 和网站存储。`,
      clear_all: "将退出所有网站登录并删除全部 Cookie、网站存储、缓存和权限；下载与文献不受影响。",
      reset_profile: "将关闭受管 Edge、归档旧专用 Profile，并创建全新的空 Profile；下载与文献不受影响。",
    };
    const item: StoredConfirmation = {
      id: randomUUID(), action, scope, title: titles[action], detail: details[action],
      expiresAt: new Date(now + 60_000).toISOString(), used: false, includePermissions,
    };
    this.items.set(item.id, item);
    return { id: item.id, action: item.action, scope: item.scope, title: item.title, detail: item.detail, expiresAt: item.expiresAt };
  }

  consume(id: string, now = Date.now()): { action: BrowserDataAction; scope: string; includePermissions: boolean } {
    const item = this.items.get(id);
    if (!item || item.used) throw confirmationError("CONFIRMATION_STALE", "The browser data confirmation is stale or already used.");
    if (Date.parse(item.expiresAt) <= now) {
      this.items.delete(id);
      throw confirmationError("CONFIRMATION_EXPIRED", "The browser data confirmation has expired.");
    }
    item.used = true;
    return { action: item.action, scope: item.scope, includePermissions: item.includePermissions };
  }
}
