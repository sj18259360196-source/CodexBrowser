import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  Circle,
  Cookie,
  Database,
  Download,
  ExternalLink,
  FileSearch,
  FileText,
  FolderOpen,
  Globe2,
  HardDrive,
  Home,
  LoaderCircle,
  MessageSquareText,
  Eye,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings,
  Search,
  ShieldAlert,
  ShieldCheck,
  Square,
  Power,
  Trash2,
  Upload,
  UserRoundCheck,
  X,
} from "lucide-react";
import type {
  AppState,
  BrowserDataAction,
  BrowserDataConfirmation,
  BrowserDialogPrompt,
  BrowserTabSummary,
  DesktopBridge,
  DownloadItem,
  RuntimeStatus,
  SessionHealthStatus,
  TaskItem,
} from "../shared/contracts";
import { BROWSER_PROTOCOL_VERSION } from "../shared/contracts";
import { sanitizeError } from "../security/redaction";
import "./styles.css";

const now = new Date().toISOString();

function safeErrorMessage(error: unknown): string {
  return sanitizeError(error).message;
}

const desktopLoadingState: AppState = {
  protocolVersion: BROWSER_PROTOCOL_VERSION,
  browserState: "READY",
  runtimeStatus: "idle",
  currentAction: "正在连接桌面浏览器",
  url: "",
  title: "Codex Browser",
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
  profileId: "primary",
  profileLabel: "正在载入 Profile",
  tabs: [],
  activeTabId: "",
  authPrompt: null,
  assistance: null,
  dialogs: [],
  sessionHealth: {
    status: "unknown",
    detail: "等待桌面端返回会话状态",
    cookieCount: 0,
    sessionCookieCount: 0,
    encryptedBackupAvailable: false,
  },
  storage: {
    taskCount: 0,
    downloadCount: 0,
    documentCount: 0,
  },
  browserStorage: { origin: "", cookieCount: 0, sessionCookieCount: 0, sessionRecoveryEnabled: false, sessionRecoveryAvailable: false, checkedAt: now },
  profileStatus: { id: "primary", label: "正在载入 Profile", state: "ready", persistent: true, browserManagedPasswords: true, syncEnabledByProject: false, detail: "正在载入浏览器数据状态", checkedAt: now },
  actionConfirmations: [],
  rememberedGrants: [],
  policyAudit: [],
  runtimeInfo: { kind: "external-edge", label: "Microsoft Edge（独立运行时）", connection: "connecting", legacy: false, detail: "正在连接受管 Edge" },
  runtimeSettings: { preferredRuntime: "external-edge", keepEdgeRunningOnControlCenterClose: true, sessionRecoveryEnabled: false, notificationsEnabled: true, downloadBehavior: "managed", documentBehavior: "import-on-request" },
  tasks: [],
  downloads: [],
  documents: [],
};

const previewState: AppState = {
  protocolVersion: BROWSER_PROTOCOL_VERSION,
  browserState: "WAITING_USER",
  runtimeStatus: "waiting_user",
  currentAction: "网页正在等待输入",
  url: "https://example.com/research-paper",
  title: "Deep learning for scientific discovery",
  isLoading: false,
  canGoBack: true,
  canGoForward: false,
  profileId: "primary",
  profileLabel: "默认研究会话",
  tabs: [
    previewTab("preview-paper", "Deep learning for scientific discovery", "https://example.com/research-paper", true, "assistance"),
    previewTab("preview-auth", "University access", "https://access.example.edu/login", false, "auth"),
    previewTab("preview-dialog", "Publisher confirmation", "https://publisher.example.com/download", false, "dialog"),
  ],
  activeTabId: "preview-paper",
  authPrompt: {
    id: "preview-auth-prompt",
    tabId: "preview-auth",
    reason: "login",
    title: "需要高校登录",
    detail: "当前论文需要机构授权。请在桌面浏览器中完成登录，Codex 会自动继续。",
    url: "https://access.example.edu/login",
    detectedAt: now,
  },
  assistance: {
    id: "preview-assistance-request",
    tabId: "preview-paper",
    taskId: "preview-download-task",
    kind: "consent",
    title: "请确认出版社下载条款",
    detail: "确认当前页面允许使用高校订阅下载这篇论文，并完成页面上的人工确认。",
    url: "https://publisher.example.com/download",
    status: "waiting_user",
    requestedAt: now,
  },
  dialogs: [
    {
      id: "preview-dialog",
      tabId: "preview-dialog",
      type: "prompt",
      message: "请输入研究项目编号以继续访问补充材料。",
      defaultValue: "RES-2026-014",
      url: "https://example.com/research-paper",
      sensitive: false,
      openedAt: now,
    },
  ],
  sessionHealth: {
    status: "attention",
    detail: "演示状态：高校登录需要人工处理",
    checkedAt: now,
    cookieCount: 18,
    sessionCookieCount: 5,
    encryptedBackupAvailable: true,
  },
  storage: {
    lastSavedAt: now,
    taskCount: 4,
    downloadCount: 2,
    documentCount: 2,
  },
  browserStorage: {
    origin: "https://a-very-long-research-subdomain.example.edu", cookieCount: 128, sessionCookieCount: 7,
    cacheBytes: 384_829_440, siteStorageBytes: 2_345_678_901, permissionCount: 3,
    sessionRecoveryEnabled: false, sessionRecoveryAvailable: false, checkedAt: now,
  },
  profileStatus: {
    id: "primary", label: "Edge 专用长期 Profile", state: "ready", persistent: true,
    browserManagedPasswords: true, syncEnabledByProject: false,
    detail: "密码和自动填充由 Microsoft Edge 管理，Codex 无法读取。", checkedAt: now,
  },
  actionConfirmations: [],
  rememberedGrants: [],
  policyAudit: [],
  runtimeInfo: { kind: "external-edge", label: "Microsoft Edge（独立运行时）", browserVersion: "150.0.4078.65", connection: "ready", legacy: false, detail: "受管 Edge 已就绪" },
  runtimeSettings: { preferredRuntime: "external-edge", keepEdgeRunningOnControlCenterClose: true, sessionRecoveryEnabled: false, notificationsEnabled: true, downloadBehavior: "managed", documentBehavior: "import-on-request" },
  tasks: [
    task("等待高校授权", "ScienceDirect · Deep learning for scientific discovery", "waiting_user", 0),
    task("点击页面元素", "Access through your institution", "done", 1),
    task("填写普通字段", "Research topic", "done", 2),
    task("生成页面快照", "37 个可交互元素", "done", 3),
  ],
  downloads: [
    {
      id: "preview-download-active",
      fileName: "research-paper.pdf",
      path: "C:\\Users\\Researcher\\Downloads\\research-paper.pdf",
      url: "https://example.com/research-paper.pdf",
      receivedBytes: 6_420_000,
      totalBytes: 10_000_000,
      state: "progressing",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "preview-download-complete",
      fileName: "literature-review.pdf",
      path: "C:\\Users\\Researcher\\Downloads\\literature-review.pdf",
      url: "https://example.com/literature-review.pdf",
      receivedBytes: 4_820_000,
      totalBytes: 4_820_000,
      state: "completed",
      createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      updatedAt: new Date(Date.now() - 18 * 60_000).toISOString(),
    },
  ],
  documents: [
    {
      id: "preview-document",
      title: "Deep learning for scientific discovery",
      fileName: "research-paper.pdf",
      pages: 28,
      characters: 84_203,
      createdAt: now,
    },
    {
      id: "preview-document-older",
      title: "Reliable browser agents for research workflows",
      fileName: "literature-review.pdf",
      pages: 19,
      characters: 62_814,
      createdAt: new Date(Date.now() - 22 * 60_000).toISOString(),
    },
  ],
};

function policyPreviewState(mode: string | null): AppState {
  if (!mode) return previewState;
  const category = mode === "payment" ? "payment" : mode === "delete" ? "deletion" : "communication";
  const status = mode === "expired" ? "expired" : mode === "executing" ? "executing" : mode === "outcome_unknown" ? "outcome_unknown" : "waiting_user";
  const summary = category === "payment" ? "发起付款或购买" : category === "deletion" ? "删除外部记录或内容" : "发送消息或提交评论";
  const impact = category === "payment" ? "将按页面显示的金额和货币产生交易" : category === "deletion" ? "操作可能不可逆" : "内容将发送到外部系统";
  return {
    ...previewState,
    assistance: null,
    authPrompt: null,
    actionConfirmations: [{
      id: "preview-policy-confirmation", tabId: "preview-paper", taskId: "preview-policy-task", category,
      origin: "https://a-very-long-external-system-subdomain.example.edu", summary, impact,
      createdAt: now, expiresAt: new Date(Date.now() + (status === "expired" ? -1_000 : 60_000)).toISOString(),
      snapshotRevision: 12, targetRef: "cb-e12-0-4", ruleId: `${category}.confirm`, status,
    }],
    rememberedGrants: mode === "grant" ? [{ id: "preview-grant", profileId: "primary", origin: "https://example.edu", category: "communication", createdAt: now, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), tabId: "preview-paper" }] : [],
    policyAudit: [
      { id: "audit-1", at: now, origin: "https://example.edu", category, ruleId: `${category}.confirm`, decision: status, tabId: "preview-paper", taskId: "preview-policy-task", result: "脱敏策略事件" },
      { id: "audit-2", at: new Date(Date.now() - 30_000).toISOString(), origin: "https://example.edu", category: "ordinary", ruleId: "ordinary.action", decision: "allow", tabId: "preview-paper", result: "普通操作已允许" },
    ],
  };
}

function runtimePreviewState(state: AppState, mode: string | null): AppState {
  if (!mode) return state;
  const legacy = mode === "legacy";
  const connection = mode === "connecting" ? "connecting" : mode === "reconnecting" ? "reconnecting" : mode === "error" ? "error" : "ready";
  return {
    ...state,
    runtimeInfo: {
      kind: legacy ? "electron-legacy" : "external-edge",
      label: legacy ? "Electron legacy runtime" : "Microsoft Edge（独立运行时）",
      browserVersion: legacy ? undefined : "150.0.4078.65",
      connection,
      legacy,
      firstRun: mode === "first-run",
      detail: mode === "error" ? "未能启动受管 Edge。请确认已安装受支持版本，然后重试。" : connection === "reconnecting" ? "正在重新连接受管 Edge" : connection === "connecting" ? "正在启动受管 Edge" : legacy ? "Legacy runtime 仅用于故障排查，不共享 Edge Profile。" : "受管 Edge 已就绪",
    },
    runtimeSettings: { ...state.runtimeSettings, preferredRuntime: legacy ? "electron-legacy" : "external-edge" },
  };
}

function releasePreviewState(state: AppState, mode: string | null): AppState {
  if (!mode || !state.assistance) return state;
  if (["verifying", "completed", "unable", "expired"].includes(mode)) {
    return {
      ...state,
      browserState: mode === "verifying" ? "VERIFYING" : "READY",
      runtimeStatus: mode === "verifying" ? "waiting_user" : "idle",
      assistance: { ...state.assistance, status: mode as "verifying" | "completed" | "unable" | "expired" },
    };
  }
  if (mode === "long") {
    return {
      ...state,
      assistance: {
        ...state.assistance,
        domain: "a-very-long-institutional-access-subdomain-for-release-validation.example.edu",
        title: "需要在独立 Microsoft Edge 中完成一项人工验证后再继续当前文献下载任务",
        detail: "这是用于验证最小窗口、中文长文本、超长域名和键盘焦点的本地预览说明。内容必须换行显示，不能覆盖操作按钮、标签页或下载与文献区域。",
      },
    };
  }
  return state;
}

function previewTab(
  id: string,
  title: string,
  url: string,
  active: boolean,
  attention: BrowserTabSummary["attention"],
): BrowserTabSummary {
  return {
    id,
    title,
    url,
    state: attention ? "WAITING_USER" : "READY",
    active,
    isLoading: false,
    canGoBack: active,
    canGoForward: false,
    attention,
    createdAt: now,
  };
}

function task(label: string, detail: string, status: TaskItem["status"], offset: number): TaskItem {
  const date = new Date(Date.now() - offset * 60_000).toISOString();
  return { id: `${label}-${offset}`, label, detail, status, createdAt: date, updatedAt: date };
}

function statusLabel(status: RuntimeStatus): string {
  switch (status) {
    case "running": return "运行中";
    case "paused": return "已暂停";
    case "waiting_user": return "等待操作";
    case "downloading": return "下载中";
    case "parsing": return "解析中";
    case "error": return "需要检查";
    default: return "就绪";
  }
}

function sessionHealthLabel(status: SessionHealthStatus): string {
  switch (status) {
    case "checking": return "正在检查";
    case "healthy": return "会话正常";
    case "attention": return "需要授权";
    case "unavailable": return "会话不可用";
    default: return "尚未检查";
  }
}

function downloadStatusLabel(download: DownloadItem): string {
  switch (download.state) {
    case "starting": return "正在开始";
    case "progressing": return download.totalBytes > 0
      ? `下载 ${Math.min(100, Math.round((download.receivedBytes / download.totalBytes) * 100))}%`
      : "正在下载";
    case "completed": return "下载完成";
    case "cancelled": return "已取消";
    default: return "下载中断";
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** unit);
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatSavedAt(value?: string): string {
  if (!value) return "等待首次保存";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "保存时间未知";
  return `已保存 ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
}

function newestByCreatedAt<T extends { createdAt: string }>(items: T[]): T | undefined {
  return items.reduce<T | undefined>((latest, item) => {
    if (!latest) return item;
    return Date.parse(item.createdAt) > Date.parse(latest.createdAt) ? item : latest;
  }, undefined);
}

function TaskStatusIcon({ status }: { status: TaskItem["status"] }) {
  if (status === "running") return <LoaderCircle className="spin task-status running" size={15} />;
  if (status === "waiting_user") return <AlertTriangle className="task-status waiting" size={15} />;
  if (status === "done") return <Check className="task-status done" size={15} />;
  if (status === "error") return <X className="task-status error" size={15} />;
  return <Circle className="task-status queued" size={13} />;
}

function IconButton({
  label,
  disabled,
  danger,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`icon-button${danger ? " danger" : ""}`}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function tabAttentionLabel(attention: BrowserTabSummary["attention"]): string {
  if (attention === "dialog") return "网页对话框等待处理";
  if (attention === "assistance") return "Codex 请求人工协助";
  if (attention === "auth") return "需要登录授权";
  return "";
}

function BrowserTabs({
  tabs,
  activeTabId,
  disabled,
  onCreate,
  onSelect,
  onClose,
}: {
  tabs: BrowserTabSummary[];
  activeTabId: string;
  disabled: boolean;
  onCreate: () => void;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
}) {
  const activeTabRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId, tabs.length]);

  return (
    <div className="tab-strip">
      <div className="tab-list" role="tablist" aria-label="浏览器标签页">
        {tabs.length === 0 ? (
          <span className="tab-loading-label">正在载入标签</span>
        ) : tabs.map((tab) => {
          const active = activeTabId ? tab.id === activeTabId : tab.active;
          return (
            <div
              className={`browser-tab${active ? " active" : ""}${tab.attention ? ` attention-${tab.attention}` : ""}`}
              key={tab.id}
              ref={active ? activeTabRef : undefined}
            >
              <button
                type="button"
                className="tab-select"
                role="tab"
                aria-selected={active}
                title={`${tab.title || "新标签页"}\n${tab.url}`}
                disabled={disabled}
                onClick={() => onSelect(tab.id)}
              >
                {tab.isLoading
                  ? <LoaderCircle className="spin tab-state" size={13} />
                  : tab.attention
                    ? <AlertTriangle className="tab-state attention" aria-label={tabAttentionLabel(tab.attention)} size={13} />
                    : <Globe2 className="tab-state" size={13} />}
                <span>{tab.title || "新标签页"}</span>
              </button>
              <button
                type="button"
                className="tab-close"
                aria-label={`关闭标签页：${tab.title || "新标签页"}`}
                title="关闭标签页"
                disabled={disabled || tabs.length <= 1}
                onClick={() => onClose(tab.id)}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <IconButton label="新建标签页" disabled={disabled} onClick={onCreate}><Plus size={15} /></IconButton>
    </div>
  );
}

function dialogTitle(dialog: BrowserDialogPrompt): string {
  if (dialog.type === "prompt") return dialog.sensitive ? "网页请求敏感输入" : "网页需要输入";
  if (dialog.type === "confirm") return "网页请求确认";
  if (dialog.type === "beforeunload") return "页面尚未完成";
  return "网页提示";
}

function MockBrowserPage() {
  return (
    <div className="mock-browser-page">
      <div className="mock-site-header">
        <div className="mock-publisher">RESEARCH ARCHIVE</div>
        <div className="mock-nav" aria-hidden="true"><span>Journals</span><span>Topics</span><span>Authors</span></div>
      </div>
      <main className="mock-paper">
        <div className="mock-breadcrumb">Journal of Computational Research / Volume 48</div>
        <h1>Deep learning for scientific discovery</h1>
        <p className="mock-authors">Lin Chen, Maya Patel, Simon Wright</p>
        <div className="mock-meta"><span>Research article</span><span>Institution access detected</span><span>2026</span></div>
        <section>
          <h2>Abstract</h2>
          <p>Machine learning systems increasingly support scientific workflows, from literature analysis to experiment design. This article evaluates reliable tool-assisted research methods across several disciplines.</p>
        </section>
        <section>
          <h2>1. Introduction</h2>
          <p>Scientific information is distributed across publisher platforms, institutional portals, structured indexes and local document collections. A useful research browser must preserve identity while keeping every automated action observable.</p>
        </section>
        <div className="mock-access-note"><CheckCircle2 size={17} /><span>PDF 入口已识别，桌面端可执行下载</span></div>
      </main>
    </div>
  );
}

function App() {
  const bridge = window.codexBrowser;
  const isPreview = !bridge;
  const phase4Preview = isPreview ? new URLSearchParams(window.location.search).get("phase4") : null;
  const phase5Preview = isPreview ? new URLSearchParams(window.location.search).get("phase5") : null;
  const phase6Preview = isPreview ? new URLSearchParams(window.location.search).get("phase6") : null;
  const phase7Preview = isPreview ? new URLSearchParams(window.location.search).get("phase7") : null;
  const [state, setState] = useState<AppState | null>(() => isPreview ? releasePreviewState(runtimePreviewState(policyPreviewState(phase5Preview), phase6Preview), phase7Preview) : null);
  const [address, setAddress] = useState(() => isPreview ? previewState.url : "");
  const [error, setError] = useState<string | null>(() => phase4Preview === "error" ? "无法刷新浏览器数据摘要。请确认受管浏览器仍在运行后重试。" : null);
  const [busyAction, setBusyAction] = useState<string | null>(() => phase4Preview === "loading" ? "data-confirm" : null);
  const [tabBusy, setTabBusy] = useState(false);
  const [dialogInput, setDialogInput] = useState("");
  const [dataOpen, setDataOpen] = useState(() => Boolean(phase4Preview));
  const [dataConfirmation, setDataConfirmation] = useState<BrowserDataConfirmation | null>(() => phase4Preview === "loading" ? {
    id: "preview-loading", action: "clear_all", scope: "all-sites", title: "清除全部浏览数据",
    detail: "将退出所有网站登录并删除全部 Cookie、网站存储、缓存和权限。下载与文献不受影响。",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  } : null);
  const [includePermissions, setIncludePermissions] = useState(false);
  const [dataMessage, setDataMessage] = useState<string | null>(() => phase4Preview === "success" ? "浏览器数据操作已完成，摘要已刷新。" : null);
  const [policyOpen, setPolicyOpen] = useState(() => Boolean(phase5Preview));
  const [runtimeOpen, setRuntimeOpen] = useState(() => Boolean(phase6Preview));
  const browserSlot = useRef<HTMLDivElement>(null);
  const addressFocused = useRef(false);

  useEffect(() => {
    if (!bridge) return;
    let disposed = false;
    const applyState = (next: AppState) => {
      if (disposed) return;
      setState(next);
      if (next.runtimeInfo.firstRun) setRuntimeOpen(true);
      if (!addressFocused.current) setAddress(next.url);
    };

    let unsubscribe: () => void = () => undefined;
    try {
      unsubscribe = bridge.subscribeState(applyState);
    } catch (subscriptionError) {
      setError(safeErrorMessage(subscriptionError));
    }

    void bridge.getState()
      .then(applyState)
      .catch((stateError) => {
        if (!disposed) {
          setError(`无法连接桌面浏览器：${safeErrorMessage(stateError)}`);
        }
      });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [bridge]);

  const desktopReady = Boolean(bridge && state);
  const viewState = state ?? desktopLoadingState;
  const blockingDialog = useMemo(
    () => viewState.dialogs.find((dialog) => dialog.tabId === viewState.activeTabId),
    [viewState.activeTabId, viewState.dialogs],
  );
  const activeAssistance = viewState.assistance
    && viewState.assistance.tabId === viewState.activeTabId
    ? viewState.assistance
    : null;
  const activeAuthPrompt = viewState.authPrompt?.tabId === viewState.activeTabId ? viewState.authPrompt : null;

  useEffect(() => {
    setDialogInput(blockingDialog?.sensitive ? "" : blockingDialog?.defaultValue ?? "");
  }, [blockingDialog?.id, blockingDialog?.sensitive]);

  useEffect(() => {
    if (!bridge || !desktopReady || !browserSlot.current) return;
    const element = browserSlot.current;
    const updateBounds = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        bridge.setBrowserBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      }
    };
    const observer = new ResizeObserver(updateBounds);
    observer.observe(element);
    window.addEventListener("resize", updateBounds);
    updateBounds();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateBounds);
    };
  }, [bridge, desktopReady, viewState.activeTabId]);

  async function invokeDesktop<T>(
    key: string,
    operation: (desktopBridge: DesktopBridge) => Promise<T>,
    onSuccess?: (result: T) => void,
  ): Promise<void> {
    if (!bridge) {
      setError("当前为网页预览模式，桌面浏览器操作已禁用。");
      return;
    }
    if (!state) {
      setError("桌面浏览器仍在初始化，请稍候。");
      return;
    }
    setError(null);
    setBusyAction(key);
    try {
      const result = await operation(bridge);
      onSuccess?.(result);
    } catch (operationError) {
      setError(safeErrorMessage(operationError));
    } finally {
      setBusyAction(null);
    }
  }

  async function invokeCritical(operation: (desktopBridge: DesktopBridge) => Promise<unknown>): Promise<void> {
    if (!bridge || !state) {
      setError(isPreview ? "当前为网页预览模式，桌面浏览器操作已禁用。" : "桌面浏览器仍在初始化，请稍候。");
      return;
    }
    setError(null);
    try {
      await operation(bridge);
    } catch (operationError) {
      setError(safeErrorMessage(operationError));
    }
  }

  async function invokeTabCommand(operation: (desktopBridge: DesktopBridge) => Promise<unknown>): Promise<void> {
    if (!bridge || !state || tabBusy) return;
    setError(null);
    setTabBusy(true);
    try {
      await operation(bridge);
    } catch (operationError) {
      setError(safeErrorMessage(operationError));
    } finally {
      setTabBusy(false);
    }
  }

  const submitAddress = (event: FormEvent) => {
    event.preventDefault();
    if (!desktopReady || !address.trim()) return;
    void invokeDesktop("navigate", (desktopBridge) => desktopBridge.navigate(address));
  };

  const activeDownload = viewState.downloads.find((download) => download.state === "progressing" || download.state === "starting");
  const recentDownload = useMemo(() => newestByCreatedAt(viewState.downloads), [viewState.downloads]);
  const recentDocument = useMemo(() => newestByCreatedAt(viewState.documents), [viewState.documents]);
  const dockDownload = activeDownload ?? recentDownload;
  const progress = activeDownload?.totalBytes
    ? Math.min(100, Math.round((activeDownload.receivedBytes / activeDownload.totalBytes) * 100))
    : 0;
  const statusClass = viewState.runtimeStatus.replace("_", "-");
  const healthClass = viewState.sessionHealth.status.replace("_", "-");
  const controlsDisabled = !desktopReady || busyAction !== null;
  const edgeManagedProfile = viewState.profileStatus.id === "primary";
  const hasActiveWork = viewState.isLoading
    || ["running", "waiting_user", "downloading", "parsing"].includes(viewState.runtimeStatus)
    || viewState.tasks.some((item) => item.status === "queued" || item.status === "running" || item.status === "waiting_user");
  const healthChecking = busyAction === "check-session" || busyAction === "complete-auth" || viewState.sessionHealth.status === "checking";
  const activeConfirmation = viewState.actionConfirmations.find((item) => ["waiting_user", "approved", "executing", "outcome_unknown", "failed"].includes(item.status)) || viewState.actionConfirmations[0];
  const grantEligible = activeConfirmation && !["payment", "account_security", "file_upload", "legal_terms", "authentication"].includes(activeConfirmation.category);

  useEffect(() => {
    if (activeConfirmation?.status === "waiting_user") setPolicyOpen(true);
  }, [activeConfirmation?.id, activeConfirmation?.status]);

  async function respondPolicy(response: "allow_once" | "allow_temporary" | "deny"): Promise<void> {
    if (!activeConfirmation || busyAction) return;
    if (!bridge) {
      setState((current) => current ? {
        ...current,
        actionConfirmations: current.actionConfirmations.map((item) => item.id === activeConfirmation.id ? { ...item, status: response === "deny" ? "denied" : "completed", resolvedAt: new Date().toISOString() } : item),
        rememberedGrants: response === "allow_temporary" ? [...current.rememberedGrants, { id: "preview-created-grant", profileId: "primary", origin: activeConfirmation.origin, category: activeConfirmation.category, createdAt: now, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), tabId: activeConfirmation.tabId }] : current.rememberedGrants,
      } : current);
      return;
    }
    await invokeDesktop(`policy-${response}`, (desktopBridge) => desktopBridge.respondActionConfirmation(activeConfirmation.id, response));
  }

  async function changeRuntimeSettings(patch: Partial<AppState["runtimeSettings"]>): Promise<void> {
    if (!bridge) {
      setState((current) => current ? { ...current, runtimeSettings: { ...current.runtimeSettings, ...patch } } : current);
      return;
    }
    await invokeDesktop("runtime-settings", (desktopBridge) => desktopBridge.updateRuntimeSettings(patch), (settings) => {
      setState((current) => current ? { ...current, runtimeSettings: settings } : current);
    });
  }

  async function requestDataAction(action: BrowserDataAction): Promise<void> {
    setDataMessage(null);
    if (!bridge) {
      const scope = action === "clear_site" ? viewState.browserStorage.origin : action === "reset_profile" ? "primary" : "all-sites";
      setDataConfirmation({ id: `preview-${action}`, action, scope, title: action === "clear_site" ? "清除当前网站数据" : action === "clear_all" ? "清除全部浏览数据" : "重置专用 Profile", detail: action === "clear_site" ? `将退出 ${scope} 的登录并删除该网站的 Cookie 和网站存储。` : action === "clear_all" ? "将退出所有网站登录并删除全部 Cookie、网站存储、缓存和权限。下载与文献不受影响。" : "将关闭受管 Edge、归档旧专用 Profile，并创建新的空 Profile。", expiresAt: new Date(Date.now() + 60_000).toISOString() });
      return;
    }
    await invokeDesktop("data-request", (desktopBridge) => desktopBridge.requestDataAction(action, includePermissions), setDataConfirmation);
  }

  async function confirmDataAction(): Promise<void> {
    if (!dataConfirmation) return;
    if (!bridge) {
      setDataMessage("预览模式未执行数据删除。确认流程和布局验证完成。");
      setDataConfirmation(null);
      return;
    }
    await invokeDesktop("data-confirm", (desktopBridge) => desktopBridge.confirmDataAction(dataConfirmation.id), (summary) => {
      setState((current) => current ? { ...current, browserStorage: summary } : current);
      setDataConfirmation(null);
      setDataMessage("浏览器数据操作已完成，摘要已刷新。");
    });
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand" title="Codex Browser">
          <div className="brand-mark"><Globe2 size={18} /></div>
          <span>Codex Browser</span>
        </div>

        <div className="nav-controls">
          <IconButton label="主页" disabled={controlsDisabled} onClick={() => void invokeDesktop("home", (desktopBridge) => desktopBridge.home())}><Home size={16} /></IconButton>
          <IconButton label="后退" disabled={controlsDisabled || !viewState.canGoBack} onClick={() => void invokeDesktop("back", (desktopBridge) => desktopBridge.back())}><ArrowLeft size={17} /></IconButton>
          <IconButton label="前进" disabled={controlsDisabled || !viewState.canGoForward} onClick={() => void invokeDesktop("forward", (desktopBridge) => desktopBridge.forward())}><ArrowRight size={17} /></IconButton>
          <IconButton label="刷新" disabled={controlsDisabled} onClick={() => void invokeDesktop("reload", (desktopBridge) => desktopBridge.reload())}><RefreshCw className={viewState.isLoading ? "spin" : ""} size={16} /></IconButton>
        </div>

        <form className="address-form" onSubmit={submitAddress}>
          <ShieldCheck size={15} className="address-security" />
          <input
            aria-label="地址或搜索"
            value={address}
            placeholder={desktopReady ? "输入网址、DOI 或检索内容" : isPreview ? "预览模式下不可导航" : "正在连接浏览器内核"}
            disabled={!desktopReady || busyAction !== null}
            onFocus={() => { addressFocused.current = true; }}
            onBlur={() => { addressFocused.current = false; }}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setAddress(viewState.url);
                event.currentTarget.blur();
              }
            }}
          />
          <button type="submit" aria-label="打开地址" title="打开地址" disabled={!desktopReady || busyAction !== null || !address.trim()}><ExternalLink size={15} /></button>
        </form>

        <button type="button" className={`runtime-pill ${statusClass}`} title={`${viewState.runtimeInfo.label} · ${viewState.runtimeInfo.detail}`} onClick={() => setRuntimeOpen(true)}>
          <span className="runtime-dot" />
          <span>{viewState.runtimeInfo.kind === "external-edge" ? "Edge" : "Legacy"} · {statusLabel(viewState.runtimeStatus)}</span>
        </button>
        <IconButton
          label={viewState.runtimeStatus === "paused" ? "继续 Codex 控制" : "暂停 Codex 控制"}
          disabled={!desktopReady}
          onClick={() => void invokeCritical(
            (desktopBridge) => viewState.runtimeStatus === "paused" ? desktopBridge.resume() : desktopBridge.pause(),
          )}
        >
          {viewState.runtimeStatus === "paused" ? <Play size={16} /> : <Pause size={16} />}
        </IconButton>
        <IconButton
          label="停止当前任务"
          danger
          disabled={!desktopReady || !hasActiveWork}
          onClick={() => void invokeCritical((desktopBridge) => desktopBridge.stop())}
        >
          <Square size={15} />
        </IconButton>
      </header>

      <div className="session-bar">
        <BrowserTabs
          tabs={viewState.tabs}
          activeTabId={viewState.activeTabId}
          disabled={!desktopReady || tabBusy}
          onCreate={() => void invokeTabCommand((desktopBridge) => desktopBridge.createTab())}
          onSelect={(tabId) => {
            if (tabId !== viewState.activeTabId) void invokeTabCommand((desktopBridge) => desktopBridge.selectTab(tabId));
          }}
          onClose={(tabId) => void invokeTabCommand((desktopBridge) => desktopBridge.closeTab(tabId))}
        />
        <span className="session-divider tab-session-divider" />
        <div className="session-cluster">
          <div className="profile-status" title={`持久化浏览器 Profile：${viewState.profileLabel}`}>
            <UserRoundCheck size={16} />
            <span>{viewState.profileLabel}</span>
          </div>
          <div className={`session-health ${healthClass}`} title={viewState.sessionHealth.detail}>
            {healthChecking
              ? <LoaderCircle className="spin" size={15} />
              : viewState.sessionHealth.status === "healthy"
                ? <ShieldCheck size={15} />
                : <ShieldAlert size={15} />}
            <strong>{sessionHealthLabel(viewState.sessionHealth.status)}</strong>
            <span>{viewState.sessionHealth.cookieCount} Cookie</span>
          </div>
          <button
            type="button"
            className="session-command"
            aria-label="检查会话"
            title="检查当前标签页会话"
            disabled={controlsDisabled}
            onClick={() => void invokeDesktop(
              "check-session",
              (desktopBridge) => desktopBridge.checkSession(),
              (health) => setState((current) => current ? { ...current, sessionHealth: health } : current),
            )}
          >
            <RefreshCw className={busyAction === "check-session" ? "spin" : ""} size={14} />
            <span>检查会话</span>
          </button>
          <div className="storage-status" title={`本地记录：${viewState.storage.taskCount} 个任务、${viewState.storage.downloadCount} 个下载、${viewState.storage.documentCount} 篇文献`}>
            <HardDrive size={15} />
            <strong>{formatSavedAt(viewState.storage.lastSavedAt)}</strong>
            <span>{viewState.storage.taskCount} 任务 · {viewState.storage.downloadCount} 下载 · {viewState.storage.documentCount} 文献</span>
          </div>
          <button type="button" className="session-command data-command" aria-label="浏览器数据" title="查看和管理专用浏览器数据" onClick={() => setDataOpen(true)}>
            <Database size={14} /><span>浏览器数据</span>
          </button>
          <button type="button" className={`session-command policy-command ${activeConfirmation?.status === "waiting_user" ? "attention" : ""}`} aria-label="操作确认与授权" title="查看高风险操作确认、临时授权和审计记录" onClick={() => setPolicyOpen(true)}>
            <ShieldCheck size={14} /><span>操作确认</span>{activeConfirmation?.status === "waiting_user" && <strong>1</strong>}
          </button>
          <div className="backup-status" title={viewState.sessionHealth.encryptedBackupAvailable ? "Cookie 会话已有本机加密备份" : "浏览器 Profile 将持续保存在本机"}>
            <Cookie size={14} />
            <span>{viewState.sessionHealth.encryptedBackupAvailable ? "会话备份已加密" : "Profile 本地持久化"}</span>
          </div>
          {isPreview && (
            <div className="preview-pill" title="网页预览模式下桌面操作已禁用">
              <AlertTriangle size={14} />
              <span className="preview-long">预览模式 · 桌面操作已禁用</span>
              <span className="preview-short">预览模式</span>
            </div>
          )}
          {!isPreview && !desktopReady && <div className="connecting-pill"><LoaderCircle className="spin" size={14} /><span>连接桌面端</span></div>}
        </div>
      </div>

      {blockingDialog ? (
        <section className={`blocking-banner dialog ${blockingDialog.type}`} role="alert">
          <AlertTriangle size={18} />
          <div className="blocking-copy">
            <strong>{dialogTitle(blockingDialog)}</strong>
            <span title={blockingDialog.message}>{blockingDialog.message}</span>
          </div>
          {blockingDialog.type === "prompt" && !blockingDialog.sensitive && (
            <input
              className="blocker-input"
              type="text"
              aria-label="网页请求的输入"
              placeholder="输入回复"
              autoComplete="off"
              maxLength={2_000}
              value={dialogInput}
              disabled={controlsDisabled}
              onChange={(event) => setDialogInput(event.target.value)}
            />
          )}
          {!blockingDialog.sensitive && <div className="blocking-actions">
            {blockingDialog.type !== "alert" && (
              <button
                type="button"
                className="blocker-button secondary"
                disabled={controlsDisabled}
                onClick={() => void invokeDesktop(
                  "respond-dialog",
                  (desktopBridge) => desktopBridge.respondDialog(blockingDialog.id, false),
                )}
              >
                <X size={14} />
                {blockingDialog.type === "beforeunload" ? "留在页面" : "取消"}
              </button>
            )}
            <button
              type="button"
              className="blocker-button primary"
              disabled={controlsDisabled}
              onClick={() => void invokeDesktop(
                "respond-dialog",
                (desktopBridge) => desktopBridge.respondDialog(
                  blockingDialog.id,
                  true,
                  blockingDialog.type === "prompt" ? dialogInput : undefined,
                ),
              )}
            >
              {busyAction === "respond-dialog" ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}
              {blockingDialog.type === "beforeunload" ? "离开页面" : blockingDialog.type === "prompt" ? "提交" : "确定"}
            </button>
          </div>}
        </section>
      ) : activeAssistance ? (
        <section className={`blocking-banner assistance ${activeAssistance.status}`} role="alert">
          <MessageSquareText size={18} />
          <div className="blocking-copy">
            <strong>{activeAssistance.status === "verifying" ? "正在检查页面" : activeAssistance.status === "completed" ? "人工步骤已完成" : activeAssistance.status === "unable" ? "人工步骤未完成" : activeAssistance.status === "expired" ? "人工请求已过期" : activeAssistance.title}</strong>
            <span title={activeAssistance.detail}>{activeAssistance.domain ? `${activeAssistance.domain} · ` : ""}{activeAssistance.detail}</span>
          </div>
          <div className="blocking-actions">
            {activeAssistance.status === "waiting_user" && <button
              type="button"
              className="blocker-button secondary"
              disabled={controlsDisabled}
              onClick={() => void invokeDesktop(
                "respond-assistance",
                (desktopBridge) => desktopBridge.respondAssistance(
                  activeAssistance.id,
                  "unable",
                ),
              )}
            >
              <X size={14} />
              无法完成
            </button>}
            {activeAssistance.status === "waiting_user" && <button
              type="button"
              className="blocker-button primary"
              disabled={controlsDisabled}
              onClick={() => void invokeDesktop(
                "respond-assistance",
                (desktopBridge) => desktopBridge.respondAssistance(
                  activeAssistance.id,
                  "completed",
                ),
              )}
            >
              {busyAction === "respond-assistance" ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}
              检查并继续
            </button>}
            {activeAssistance.status === "verifying" && <LoaderCircle className="spin" size={16} />}
            {(activeAssistance.status === "waiting_user" || activeAssistance.status === "verifying") && <button
              type="button"
              className="blocker-button stop"
              disabled={!desktopReady}
              onClick={() => void invokeCritical((desktopBridge) => desktopBridge.stop())}
            ><Square size={13} />停止任务</button>}
          </div>
        </section>
      ) : activeAuthPrompt ? (
        <section className="blocking-banner auth" role="alert">
          <AlertTriangle size={18} />
          <div className="blocking-copy">
            <strong>{activeAuthPrompt.title}</strong>
            <span title={activeAuthPrompt.detail}>{activeAuthPrompt.detail}</span>
          </div>
          <button
            type="button"
            className="blocker-button primary"
            disabled={controlsDisabled}
            onClick={() => void invokeDesktop(
              "complete-auth",
              (desktopBridge) => desktopBridge.completeAuth(activeAuthPrompt.id),
              (health) => setState((current) => current ? { ...current, sessionHealth: health } : current),
            )}
          >
            {busyAction === "complete-auth" ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}
            检查授权并继续
          </button>
        </section>
      ) : (
        <section className="blocking-banner idle" aria-live="polite">
          <Activity size={18} />
          <div className="blocking-copy">
            <strong>{statusLabel(viewState.runtimeStatus)}</strong>
            <span title={viewState.currentAction}>{viewState.currentAction}</span>
          </div>
        </section>
      )}

      {error && (
        <div className="error-strip" role="alert">
          <AlertTriangle size={15} />
          <span>{error}</span>
          <button type="button" aria-label="关闭错误提示" title="关闭错误提示" onClick={() => setError(null)}><X size={14} /></button>
        </div>
      )}

      {dataOpen && <div className="modal-backdrop" role="presentation">
        <section className="data-dialog" role="dialog" aria-modal="true" aria-labelledby="data-dialog-title">
          <header className="data-dialog-header">
            <div><strong id="data-dialog-title">浏览器数据</strong><span>{viewState.profileStatus.label}</span></div>
            <button type="button" aria-label="关闭浏览器数据" title="关闭" onClick={() => { setDataOpen(false); setDataConfirmation(null); }}><X size={17} /></button>
          </header>
          <div className="data-dialog-body">
            <div className="data-origin"><Globe2 size={16} /><span title={viewState.browserStorage.origin || "当前页面无网站 origin"}>{viewState.browserStorage.origin || "当前页面无网站 origin"}</span></div>
            <dl className="storage-grid">
              <div><dt>Cookie</dt><dd>{viewState.browserStorage.cookieCount.toLocaleString()}</dd></div>
              <div><dt>临时会话 Cookie</dt><dd>{viewState.browserStorage.sessionCookieCount.toLocaleString()}</dd></div>
              <div><dt>网站存储</dt><dd>{viewState.browserStorage.siteStorageBytes == null ? "不可用" : formatBytes(viewState.browserStorage.siteStorageBytes)}</dd></div>
              <div><dt>缓存</dt><dd>{viewState.browserStorage.cacheBytes == null ? "不可用" : formatBytes(viewState.browserStorage.cacheBytes)}</dd></div>
              <div><dt>权限摘要</dt><dd>{viewState.browserStorage.permissionCount == null ? "不可用" : `${viewState.browserStorage.permissionCount} 项`}</dd></div>
              <div><dt>Profile</dt><dd>{viewState.profileStatus.state === "ready" ? "可用" : viewState.profileStatus.state}</dd></div>
            </dl>
            <section className="recovery-row">
              <div><strong>临时会话恢复</strong><span>正常浏览器语义优先。启用后仅使用 Windows 用户绑定加密和短期 TTL；Edge 模式保持关闭。</span></div>
              <label className="switch-control"><input type="checkbox" checked={viewState.browserStorage.sessionRecoveryEnabled} disabled={!bridge || viewState.profileStatus.id === "primary" || busyAction !== null} onChange={(event) => void invokeDesktop("session-recovery", (desktopBridge) => desktopBridge.setSessionRecovery(event.target.checked), (summary) => setState((current) => current ? { ...current, browserStorage: summary } : current))} /><span /></label>
            </section>
            <p className="password-boundary">密码、自动填充和保存提示由 Edge 管理。Codex Browser 不读取密码、不显示密码数量，也不会自动启用 Microsoft 同步。</p>
            <label className="permission-option"><input type="checkbox" checked={includePermissions} disabled={edgeManagedProfile || busyAction !== null} onChange={(event) => setIncludePermissions(event.target.checked)} />{edgeManagedProfile ? "当前 Edge 版本不支持可靠的按站点权限重置；全部数据清除会重置权限" : "清除当前网站时同时重置网站权限"}</label>
            <div className="data-actions">
              <button type="button" disabled={!viewState.browserStorage.origin || busyAction !== null} onClick={() => void requestDataAction("clear_site")}><Trash2 size={15} />清除当前网站数据</button>
              <button type="button" disabled={busyAction !== null} onClick={() => void requestDataAction("clear_all")}><Trash2 size={15} />清除全部浏览数据</button>
              <button type="button" className="danger" disabled={busyAction !== null} onClick={() => void requestDataAction("reset_profile")}><RotateCcw size={15} />重置专用 Profile</button>
            </div>
            {dataMessage && <div className="data-message" role="status">{dataMessage}</div>}
          </div>
          {dataConfirmation && <div className="confirmation-sheet">
            <AlertTriangle size={20} />
            <div><strong>{dataConfirmation.title}</strong><span>{dataConfirmation.detail}</span><small>确认仅对当前操作和范围有效，60 秒后过期且只能使用一次。</small></div>
            <div className="confirmation-actions"><button type="button" onClick={() => setDataConfirmation(null)}>取消</button><button type="button" className="danger" autoFocus disabled={busyAction !== null} onClick={() => void confirmDataAction()}>{busyAction === "data-confirm" ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}确认执行</button></div>
          </div>}
        </section>
      </div>}

      {policyOpen && <div className="modal-backdrop" role="presentation">
        <section className="data-dialog policy-dialog" role="dialog" aria-modal="true" aria-labelledby="policy-dialog-title">
          <header className="data-dialog-header">
            <div><strong id="policy-dialog-title">操作确认与授权</strong><span>高风险操作由用户决定，Codex 不能自行批准</span></div>
            <button type="button" aria-label="关闭操作确认" title="关闭" onClick={() => setPolicyOpen(false)}><X size={17} /></button>
          </header>
          <div className="policy-dialog-body">
            <section className={`policy-current ${activeConfirmation?.status || "empty"}`}>
              {activeConfirmation ? <>
                <div className="policy-title-row"><AlertTriangle size={19} /><div><strong>{activeConfirmation.summary}</strong><span>{activeConfirmation.origin}</span></div><span className="policy-status">{activeConfirmation.status}</span></div>
                <p>{activeConfirmation.impact}</p>
                <dl className="policy-facts"><div><dt>操作类别</dt><dd>{activeConfirmation.category}</dd></div><div><dt>策略规则</dt><dd>{activeConfirmation.ruleId}</dd></div><div><dt>有效期</dt><dd>{new Date(activeConfirmation.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</dd></div></dl>
                {activeConfirmation.status === "waiting_user" && <div className="policy-actions">
                  <button type="button" className="primary" disabled={busyAction !== null} onClick={() => void respondPolicy("allow_once")}><Check size={15} />允许一次</button>
                  {grantEligible && <button type="button" disabled={busyAction !== null} onClick={() => void respondPolicy("allow_temporary")}><ShieldCheck size={15} />短期允许本网站此类操作</button>}
                  <button type="button" className="danger" disabled={busyAction !== null} onClick={() => void respondPolicy("deny")}><X size={15} />拒绝</button>
                  <button
                    type="button"
                    disabled={!bridge || busyAction !== null}
                    onClick={() => void invokeDesktop("stop", (desktopBridge) => desktopBridge.stop())}
                  >
                    <Square size={14} />
                    停止任务
                  </button>
                </div>}
                {activeConfirmation.status === "executing" && <div className="policy-progress"><LoaderCircle className="spin" size={16} />重新验证页面并执行一次，按钮已锁定</div>}
                {activeConfirmation.status === "outcome_unknown" && <div className="policy-warning">执行结果不确定。系统不会自动重试，请在浏览器中检查。</div>}
              </> : <div className="policy-empty"><ShieldCheck size={18} /><span>当前没有待确认的高风险操作</span></div>}
            </section>
            <section className="policy-section"><header><div><strong>临时授权</strong><span>仅限指定 Profile、网站、类别和短期有效期</span></div></header>
              <div className="policy-list">
                {viewState.rememberedGrants.length ? viewState.rememberedGrants.map((grant) => (
                  <div className="grant-row" key={grant.id}>
                    <div>
                      <strong>{grant.category}</strong>
                      <span title={grant.origin}>{grant.origin}</span>
                      <small>到期 {new Date(grant.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small>
                    </div>
                    <button
                      type="button"
                      disabled={busyAction !== null}
                      onClick={() => {
                        if (bridge) {
                          void invokeDesktop("grant-revoke", (desktopBridge) => desktopBridge.revokeBrowserGrant(grant.id));
                          return;
                        }
                        setState((current) => current
                          ? { ...current, rememberedGrants: current.rememberedGrants.filter((item) => item.id !== grant.id) }
                          : current);
                      }}
                    >
                      <X size={14} />
                      撤销
                    </button>
                  </div>
                )) : <div className="policy-empty">没有有效的临时授权</div>}
              </div>
            </section>
            <section className="policy-section audit-section"><header><div><strong>脱敏审计</strong><span>不保存消息正文、支付信息、密码、Cookie 或本地路径</span></div><button type="button" disabled={!viewState.policyAudit.length || busyAction !== null} onClick={() => {
              if (bridge) {
                void invokeDesktop("audit-clear", (desktopBridge) => desktopBridge.clearPolicyAudit());
                return;
              }
              setState((current) => current ? { ...current, policyAudit: [] } : current);
            }}>清除审计记录</button></header>
              <div className="audit-list">{viewState.policyAudit.slice(0, 40).map((entry) => <div className="audit-row" key={entry.id}><time>{new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time><strong>{entry.decision}</strong><span>{entry.category} · {entry.ruleId}</span><small title={entry.origin}>{entry.origin}</small></div>)}</div>
            </section>
          </div>
        </section>
      </div>}

      {runtimeOpen && <div className="modal-backdrop" role="presentation">
        <section className="data-dialog runtime-dialog" role="dialog" aria-modal="true" aria-labelledby="runtime-dialog-title">
          <header className="data-dialog-header">
            <div><strong id="runtime-dialog-title">浏览器运行时与设置</strong><span>{viewState.runtimeInfo.label}</span></div>
            <button type="button" aria-label="关闭运行时设置" title="关闭" onClick={() => setRuntimeOpen(false)}><X size={17} /></button>
          </header>
          <div className="runtime-dialog-body">
            {viewState.runtimeInfo.firstRun && <section className="first-run-panel">
              <Globe2 size={22} />
              <div><strong>开始使用独立 Microsoft Edge</strong><p>检测到 Edge {viewState.runtimeInfo.browserVersion || "受支持版本"}。Codex Browser 使用与日常 Edge 完全隔离的专用 Profile；密码和自动填充由 Edge 管理，Codex 无法读取密码或 Cookie 值。登录、MFA、网页挑战和高风险操作会请你在可见窗口中处理。</p></div>
            </section>}
            {viewState.runtimeInfo.legacy && <div className="legacy-warning" role="alert"><AlertTriangle size={18} /><div><strong>正在使用 legacy runtime</strong><span>仅用于故障排查。它不共享也不会覆盖独立 Edge Profile 的登录状态或网站数据。</span></div></div>}
            <dl className="runtime-summary">
              <div><dt>当前 runtime</dt><dd>{viewState.runtimeInfo.kind}</dd></div>
              <div><dt>浏览器版本</dt><dd>{viewState.runtimeInfo.browserVersion || "由 Electron 管理"}</dd></div>
              <div><dt>连接状态</dt><dd>{viewState.runtimeInfo.connection}</dd></div>
              <div><dt>Profile</dt><dd>{viewState.profileStatus.state === "ready" ? "专用 Profile 可用" : viewState.profileStatus.state}</dd></div>
            </dl>
            <p className={`runtime-detail ${viewState.runtimeInfo.connection}`}>{viewState.runtimeInfo.detail}</p>
            <div className="runtime-actions">
              <button type="button" disabled={busyAction !== null} onClick={() => bridge ? void invokeDesktop("runtime-show", (desktopBridge) => desktopBridge.showBrowser()) : undefined}><Eye size={15} />{viewState.runtimeInfo.firstRun ? "启动并显示浏览器" : "显示浏览器"}</button>
              <button type="button" disabled={busyAction !== null} onClick={() => bridge ? void invokeDesktop("runtime-restart", (desktopBridge) => desktopBridge.restartBrowser()) : undefined}><RotateCcw size={15} />重启浏览器</button>
              <button type="button" className="danger" disabled={busyAction !== null} onClick={() => bridge ? void invokeDesktop("runtime-shutdown", (desktopBridge) => desktopBridge.shutdownBrowser()) : undefined}><Power size={15} />停止浏览器</button>
            </div>
            <section className="runtime-settings-section">
              <header><Settings size={16} /><div><strong>设置</strong><span>切换 runtime 后需要重新启动 Codex Browser</span></div></header>
              <label className="runtime-setting-row"><div><strong>首选 runtime</strong><span>正常使用独立 Edge；legacy 仅用于故障排查</span></div><select value={viewState.runtimeSettings.preferredRuntime} disabled={busyAction !== null} onChange={(event) => void changeRuntimeSettings({ preferredRuntime: event.target.value as AppState["runtimeSettings"]["preferredRuntime"] })}><option value="external-edge">external-edge</option><option value="electron-legacy">electron-legacy</option></select></label>
              <label className="runtime-setting-row"><div><strong>关闭控制中心时保持 Edge 运行</strong><span>保留网页和下载状态，稍后可重新打开控制中心</span></div><input type="checkbox" checked={viewState.runtimeSettings.keepEdgeRunningOnControlCenterClose} disabled={busyAction !== null || viewState.runtimeInfo.legacy} onChange={(event) => void changeRuntimeSettings({ keepEdgeRunningOnControlCenterClose: event.target.checked })} /></label>
              <label className="runtime-setting-row"><div><strong>系统通知</strong><span>仅在人工接管或高风险确认时通知一次</span></div><input type="checkbox" checked={viewState.runtimeSettings.notificationsEnabled} disabled={busyAction !== null} onChange={(event) => void changeRuntimeSettings({ notificationsEnabled: event.target.checked })} /></label>
              <div className="runtime-setting-row fixed"><div><strong>下载与文献</strong><span>下载保存在项目管理目录；PDF 仅在明确请求时导入文献库</span></div><span>受管</span></div>
            </section>
          </div>
        </section>
      </div>}

      <div className="workspace">
        <aside className="task-sidebar">
          <div className="sidebar-heading">
            <Activity size={16} />
            <span>Codex 动作</span>
            <span className="count">{viewState.tasks.length}</span>
            <IconButton
              label="清理任务记录"
              disabled={controlsDisabled || viewState.tasks.length === 0}
              onClick={() => void invokeDesktop("clear-tasks", (desktopBridge) => desktopBridge.clearTasks())}
            >
              <Trash2 size={14} />
            </IconButton>
          </div>
          <div className="task-list">
            {viewState.tasks.length === 0 ? (
              <div className="empty-state"><Circle size={16} /><span>等待 Codex 调用浏览器</span></div>
            ) : viewState.tasks.map((item) => (
              <div className="task-row" key={item.id}>
                <TaskStatusIcon status={item.status} />
                <div className="task-copy"><strong>{item.label}</strong>{item.detail && <span>{item.detail}</span>}</div>
              </div>
            ))}
          </div>

          <section className="asset-section">
            <div className="sidebar-heading asset-heading">
              <Download size={16} />
              <span>最近下载</span>
              <span className="count">{viewState.downloads.length}</span>
              <IconButton
                label="清理下载记录"
                disabled={controlsDisabled || viewState.downloads.length === 0}
                onClick={() => void invokeDesktop("clear-downloads", (desktopBridge) => desktopBridge.clearDownloads())}
              >
                <Trash2 size={14} />
              </IconButton>
            </div>
            {recentDownload ? (
              <div className="asset-row">
                <div className={`asset-icon download ${recentDownload.state}`}><Download size={16} /></div>
                <div className="asset-copy">
                  <strong title={recentDownload.fileName}>{recentDownload.fileName}</strong>
                  <span>{downloadStatusLabel(recentDownload)} · {formatBytes(recentDownload.totalBytes || recentDownload.receivedBytes)}</span>
                </div>
                <IconButton
                  label="打开下载文件"
                  disabled={controlsDisabled || recentDownload.state !== "completed"}
                  onClick={() => void invokeDesktop("open-download", (desktopBridge) => desktopBridge.openDownload(recentDownload.id))}
                >
                  <ExternalLink size={14} />
                </IconButton>
              </div>
            ) : <div className="asset-empty">暂无下载记录</div>}
          </section>

          <section className="asset-section document-section">
            <div className="sidebar-heading asset-heading">
              <BookOpen size={16} />
              <span>最近文献</span>
              <span className="count">{viewState.documents.length}</span>
            </div>
            {recentDocument ? (
              <div className="asset-row">
                <div className="asset-icon document"><FileText size={16} /></div>
                <div className="asset-copy">
                  <strong title={recentDocument.title}>{recentDocument.title}</strong>
                  <span>{recentDocument.pages} 页 · {recentDocument.characters.toLocaleString()} 字符</span>
                </div>
                <IconButton
                  label="打开本地文献"
                  disabled={controlsDisabled}
                  onClick={() => void invokeDesktop("open-document", (desktopBridge) => desktopBridge.openDocument(recentDocument.id))}
                >
                  <FileSearch size={14} />
                </IconButton>
              </div>
            ) : <div className="asset-empty">尚未导入 PDF</div>}
            <button
              type="button"
              className="sidebar-command"
              disabled={controlsDisabled}
              onClick={() => void invokeDesktop("import-pdf", (desktopBridge) => desktopBridge.importPdf())}
            >
              <Upload size={15} />
              导入 PDF
            </button>
          </section>
        </aside>

        <main className="browser-stage">
          <div className="browser-slot" ref={browserSlot}>
            {isPreview && <MockBrowserPage />}
            {!isPreview && !desktopReady && (
              <div className="browser-loading"><LoaderCircle className="spin" size={24} /><span>正在连接 Chromium 会话</span></div>
            )}
          </div>
          <div className="action-strip">
            <span className={`action-dot ${viewState.runtimeStatus === "paused" ? "paused" : viewState.runtimeStatus === "error" ? "error" : "active"}`} />
            <strong>Codex</strong>
            <span className="action-text">{viewState.currentAction}</span>
            <span className="action-page" title={viewState.title}>{viewState.title}</span>
          </div>
        </main>
      </div>

      <footer className="bottom-dock">
        <div className="download-icon"><Download size={18} /></div>
        <div className="download-copy">
          <strong>{dockDownload ? dockDownload.fileName : "下载队列"}</strong>
          <span>{activeDownload ? `${progress}% · 正在使用当前浏览器会话` : recentDownload ? downloadStatusLabel(recentDownload) : `${viewState.documents.length} 篇文献已解析`}</span>
        </div>
        <div className="progress-track" aria-label="下载进度"><span style={{ width: `${progress}%` }} /></div>
        <button
          type="button"
          className="dock-button"
          disabled={controlsDisabled}
          onClick={() => void invokeDesktop("open-downloads", (desktopBridge) => desktopBridge.openDownloads())}
        >
          <FolderOpen size={16} />
          打开目录
        </button>
        <div className="protocol"><Search size={14} /><span>MCP {viewState.protocolVersion}</span></div>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
