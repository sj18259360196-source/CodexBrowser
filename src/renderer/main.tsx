import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import appIconUrl from "./assets/app-icon.png";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock3,
  Cookie,
  Download,
  ExternalLink,
  FileInput,
  FileOutput,
  FileSearch,
  FileText,
  FolderOpen,
  Globe2,
  HardDrive,
  History,
  Home,
  KeyRound,
  Layers3,
  LoaderCircle,
  MessageSquareText,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Upload,
  UserRoundCheck,
  X,
} from "lucide-react";
import {
  BROWSER_PROTOCOL_VERSION,
  type AppState,
  type BrowserSkill,
  type BrowserSkillRisk,
  type BrowserSkillRunStatus,
  type BrowserSkillStatus,
  type BrowserSkillTraceStatus,
  type BrowserDialogPrompt,
  type BrowserTabSummary,
  type DesktopBridge,
  type DownloadItem,
  type RuntimeStatus,
  type SessionHealthStatus,
  type TaskItem,
} from "../shared/contracts";
import "./styles.css";

const now = new Date().toISOString();

const desktopLoadingState: AppState = {
  protocolVersion: BROWSER_PROTOCOL_VERSION,
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
  credentialVault: {
    encryptionAvailable: false,
    savedSiteCount: 0,
    activeSiteSaved: false,
  },
  storage: {
    taskCount: 0,
    downloadCount: 0,
    documentCount: 0,
    browserSkillCount: 0,
    browserSkillTraceCount: 0,
  },
  tasks: [],
  downloads: [],
  documents: [],
  browserSkills: [],
  browserSkillTraces: [],
  browserSkillRun: null,
};

const previewState: AppState = {
  protocolVersion: BROWSER_PROTOCOL_VERSION,
  runtimeStatus: "waiting_user",
  currentAction: "等待高校登录授权",
  url: "https://access.example.edu/login",
  title: "University access",
  isLoading: false,
  canGoBack: true,
  canGoForward: false,
  profileId: "primary",
  profileLabel: "默认研究会话",
  tabs: [
    previewTab("preview-paper", "Deep learning for scientific discovery", "https://example.com/research-paper", false, "assistance"),
    previewTab("preview-auth", "University access", "https://access.example.edu/login", true, "auth"),
    previewTab("preview-dialog", "Publisher confirmation", "https://publisher.example.com/download", false, "dialog"),
  ],
  activeTabId: "preview-auth",
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
  credentialVault: {
    encryptionAvailable: true,
    savedSiteCount: 1,
    activeSiteSaved: false,
  },
  storage: {
    lastSavedAt: now,
    taskCount: 4,
    downloadCount: 2,
    documentCount: 2,
    browserSkillCount: 2,
    browserSkillTraceCount: 2,
  },
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
  browserSkills: [
    {
      schemaVersion: 1,
      id: "preview-search-skill",
      name: "站内搜索并打开首个结果",
      description: "在支持搜索的网站填写关键词，提交检索并打开第一个匹配结果。",
      status: "enabled",
      risk: "confirmation",
      trigger: {
        hosts: ["portal.example.com"],
        pathPatterns: ["/search*", "/catalog*"],
        keywords: ["搜索", "查找", "打开结果"],
      },
      inputs: [
        { name: "query", label: "搜索内容", type: "text", required: true, sensitive: false, defaultValue: "browser automation" },
      ],
      steps: [
        { id: "search-fill", label: "填写搜索内容", method: "browser.act", params: { action: "fill", text: "{{query}}" }, target: { role: "searchbox", name: "搜索" }, risk: "interaction" },
        { id: "search-submit", label: "提交搜索", method: "browser.act", params: { action: "press", key: "Enter" }, target: { role: "searchbox", name: "搜索" }, risk: "confirmation" },
        { id: "search-open", label: "打开首个结果", method: "browser.act", params: { action: "click" }, target: { role: "link", name: "第一个搜索结果" }, risk: "interaction" },
      ],
      stats: { runCount: 12, successCount: 11, failureCount: 1, averageDurationMs: 4_800, lastRunAt: now, lastSuccessAt: now },
      source: "learned",
      version: 3,
      createdAt: new Date(Date.now() - 12 * 24 * 60 * 60_000).toISOString(),
      updatedAt: now,
    },
    {
      schemaVersion: 1,
      id: "preview-support-skill",
      name: "填写并提交支持请求",
      description: "按主题和说明填写网站支持表单，在最终提交前要求用户确认。",
      status: "draft",
      risk: "confirmation",
      trigger: {
        hosts: ["support.example.com"],
        pathPatterns: ["/requests/new"],
        keywords: ["支持请求", "提交工单"],
      },
      inputs: [
        { name: "subject", label: "主题", type: "text", required: true, sensitive: false },
        { name: "detail", label: "问题说明", type: "text", required: true, sensitive: false },
      ],
      steps: [
        { id: "support-subject", label: "填写主题", method: "browser.act", params: { action: "fill", text: "{{subject}}" }, target: { role: "textbox", name: "主题" }, risk: "interaction" },
        { id: "support-detail", label: "填写问题说明", method: "browser.act", params: { action: "fill", text: "{{detail}}" }, target: { role: "textbox", name: "问题说明" }, risk: "interaction" },
        { id: "support-submit", label: "提交支持请求", method: "browser.act", params: { action: "click" }, target: { role: "button", name: "提交" }, risk: "confirmation" },
      ],
      stats: { runCount: 0, successCount: 0, failureCount: 0, averageDurationMs: 0 },
      source: "learned",
      sourceTraceId: "preview-support-trace",
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
  ],
  browserSkillTraces: [
    {
      id: "preview-recording-trace",
      title: "整理后台待处理项目",
      host: "workspace.example.com",
      status: "recording",
      operationCount: 3,
      startedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
      updatedAt: new Date(Date.now() - 30_000).toISOString(),
    },
    {
      id: "preview-export-trace",
      title: "筛选后台列表并导出当前结果",
      host: "admin.example.com",
      status: "ready",
      operationCount: 7,
      startedAt: new Date(Date.now() - 18 * 60_000).toISOString(),
      updatedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    },
    {
      id: "preview-support-trace",
      title: "填写网站支持请求",
      host: "support.example.com",
      status: "learned",
      operationCount: 5,
      startedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      updatedAt: new Date(Date.now() - 90 * 60_000).toISOString(),
      draftSkillId: "preview-support-skill",
    },
  ],
  browserSkillRun: {
    id: "preview-run",
    skillId: "preview-search-skill",
    skillName: "站内搜索并打开首个结果",
    status: "running",
    currentStep: 2,
    totalSteps: 3,
    detail: "正在等待搜索结果页面稳定",
    startedAt: now,
  },
};

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

function skillStatusLabel(status: BrowserSkillStatus): string {
  if (status === "enabled") return "已启用";
  if (status === "disabled") return "已停用";
  if (status === "stale") return "需复核";
  return "草稿";
}

function skillRiskLabel(risk: BrowserSkillRisk): string {
  if (risk === "read_only") return "只读";
  if (risk === "confirmation") return "运行前确认";
  return "普通交互";
}

function traceStatusLabel(status: BrowserSkillTraceStatus): string {
  if (status === "recording") return "记录中";
  if (status === "learned") return "已生成技能";
  if (status === "discarded") return "已忽略";
  return "待学习";
}

function skillRunStatusLabel(status: BrowserSkillRunStatus): string {
  if (status === "running") return "运行中";
  if (status === "done") return "已完成";
  if (status === "cancelled") return "已取消";
  return "失败";
}

function formatDuration(durationMs: number): string {
  if (durationMs <= 0) return "尚无数据";
  if (durationMs < 1_000) return `${Math.round(durationMs)} 毫秒`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} 秒`;
  return `${Math.round(durationMs / 60_000)} 分钟`;
}

function formatRelativeTime(value?: string): string {
  if (!value) return "尚未运行";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "时间未知";
  const elapsedMinutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (elapsedMinutes < 1) return "刚刚";
  if (elapsedMinutes < 60) return `${elapsedMinutes} 分钟前`;
  if (elapsedMinutes < 24 * 60) return `${Math.round(elapsedMinutes / 60)} 小时前`;
  return new Date(timestamp).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

function parseList(value: string): string[] {
  return value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
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

type BrowserSkillDrawerTab = "skills" | "learning" | "runs";

function BrowserSkillDrawer({
  skills,
  traces,
  currentRun,
  busy,
  notice,
  onClose,
  onImport,
  onSave,
  onStatus,
  onDelete,
  onExport,
  onLearnTrace,
  onDiscardTrace,
  onRun,
}: {
  skills: BrowserSkill[];
  traces: AppState["browserSkillTraces"];
  currentRun: AppState["browserSkillRun"];
  busy: boolean;
  notice: string | null;
  onClose: () => void;
  onImport: () => void;
  onSave: (skill: BrowserSkill) => void;
  onStatus: (skill: BrowserSkill, status: BrowserSkillStatus) => void;
  onDelete: (skill: BrowserSkill) => void;
  onExport: (skill: BrowserSkill) => void;
  onLearnTrace: (traceId: string) => void;
  onDiscardTrace: (traceId: string) => void;
  onRun: (skill: BrowserSkill, inputs: Record<string, string | number | boolean>, confirmed: boolean) => void;
}) {
  const [tab, setTab] = useState<BrowserSkillDrawerTab>("skills");
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(skills[0]?.id ?? null);
  const [editing, setEditing] = useState<BrowserSkill | null>(null);
  const [runInputs, setRunInputs] = useState<Record<string, string | number | boolean>>({});
  const [runConfirmed, setRunConfirmed] = useState(false);
  const selectedSkill = skills.find((skill) => skill.id === selectedSkillId) ?? skills[0] ?? null;

  useEffect(() => {
    if (!selectedSkill && skills[0]) setSelectedSkillId(skills[0].id);
    if (selectedSkillId && !skills.some((skill) => skill.id === selectedSkillId)) {
      setSelectedSkillId(skills[0]?.id ?? null);
    }
  }, [selectedSkill, selectedSkillId, skills]);

  useEffect(() => {
    if (!selectedSkill) {
      setRunInputs({});
      return;
    }
    setRunInputs(Object.fromEntries(selectedSkill.inputs.map((input) => [
      input.name,
      input.defaultValue ?? (input.type === "boolean" ? false : ""),
    ])));
    setRunConfirmed(false);
    setEditing(null);
  }, [selectedSkill?.id]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const requiredInputsMissing = selectedSkill?.inputs.some((input) => {
    if (!input.required) return false;
    const value = runInputs[input.name];
    return input.type === "boolean" ? value === undefined : String(value ?? "").trim().length === 0;
  }) ?? false;
  const runNeedsConfirmation = selectedSkill?.risk === "confirmation";

  const openSkill = (skillId: string) => {
    setSelectedSkillId(skillId);
    setTab("skills");
  };

  return (
    <aside className="skill-drawer" aria-label="浏览器技能库">
      <div className="skill-drawer-header">
        <div className="skill-drawer-title">
          <BrainCircuit size={18} />
          <div><strong>浏览器技能</strong><span>{skills.length} 个技能 · {traces.filter((trace) => ["recording", "ready"].includes(trace.status)).length} 条待学习</span></div>
        </div>
        <IconButton label="关闭技能库" onClick={onClose}><X size={16} /></IconButton>
      </div>

      <div className="skill-tabs" role="tablist" aria-label="技能库视图">
        <button type="button" role="tab" aria-selected={tab === "skills"} className={tab === "skills" ? "active" : ""} onClick={() => setTab("skills")}>
          <Layers3 size={14} /><span>技能</span><b>{skills.length}</b>
        </button>
        <button type="button" role="tab" aria-selected={tab === "learning"} className={tab === "learning" ? "active" : ""} onClick={() => setTab("learning")}>
          <Sparkles size={14} /><span>待学习</span><b>{traces.filter((trace) => ["recording", "ready"].includes(trace.status)).length}</b>
        </button>
        <button type="button" role="tab" aria-selected={tab === "runs"} className={tab === "runs" ? "active" : ""} onClick={() => setTab("runs")}>
          <History size={14} /><span>运行</span>{currentRun?.status === "running" && <i />}
        </button>
      </div>

      {notice && <div className="skill-notice" role="status"><CheckCircle2 size={14} /><span>{notice}</span></div>}

      {tab === "skills" && (
        <div className="skill-drawer-content">
          <div className="skill-command-bar">
            <strong>我的技能</strong>
            <button type="button" className="compact-command" disabled={busy} onClick={onImport}><FileInput size={14} />导入</button>
          </div>

          <div className="skill-list" aria-label="技能列表">
            {skills.length === 0 ? (
              <div className="skill-empty"><BrainCircuit size={22} /><strong>还没有浏览器技能</strong><span>完成网页操作后，可从“待学习”生成技能草稿。</span></div>
            ) : skills.map((skill) => (
              <button
                type="button"
                className={`skill-list-row${skill.id === selectedSkill?.id ? " selected" : ""}`}
                key={skill.id}
                onClick={() => setSelectedSkillId(skill.id)}
              >
                <span className={`skill-state-dot ${skill.status}`} />
                <span className="skill-list-copy"><strong>{skill.name}</strong><span>{skill.trigger.hosts[0] ?? "所有网站"} · {skill.steps.length} 步</span></span>
                <span className={`skill-status ${skill.status}`}>{skillStatusLabel(skill.status)}</span>
                <ChevronRight size={14} />
              </button>
            ))}
          </div>

          {selectedSkill && editing ? (
            <form
              className="skill-detail skill-editor"
              onSubmit={(event) => {
                event.preventDefault();
                onSave({ ...editing, name: editing.name.trim(), description: editing.description.trim(), updatedAt: new Date().toISOString() });
                setEditing(null);
              }}
            >
              <div className="skill-detail-heading">
                <div><span className="section-kicker">编辑技能</span><strong>{editing.name || "未命名技能"}</strong></div>
                <IconButton label="取消编辑" onClick={() => setEditing(null)}><X size={15} /></IconButton>
              </div>
              <label className="skill-field"><span>名称</span><input required maxLength={120} value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></label>
              <label className="skill-field"><span>说明</span><textarea rows={3} maxLength={1_000} value={editing.description} onChange={(event) => setEditing({ ...editing, description: event.target.value })} /></label>
              <div className="skill-field-grid">
                <label className="skill-field"><span>状态</span><select value={editing.status} onChange={(event) => setEditing({ ...editing, status: event.target.value as BrowserSkillStatus })}><option value="draft">草稿</option><option value="enabled">已启用</option><option value="disabled">已停用</option><option value="stale">需复核</option></select></label>
                <label className="skill-field"><span>风险</span><select value={editing.risk} onChange={(event) => setEditing({ ...editing, risk: event.target.value as BrowserSkillRisk })}><option value="read_only">只读</option><option value="interaction">普通交互</option><option value="confirmation">运行前确认</option></select></label>
              </div>
              <label className="skill-field"><span>适用域名</span><input placeholder="example.com, app.example.com" value={editing.trigger.hosts.join(", ")} onChange={(event) => setEditing({ ...editing, trigger: { ...editing.trigger, hosts: parseList(event.target.value) } })} /></label>
              <label className="skill-field"><span>路径模式</span><input placeholder="/search*, /items/*" value={editing.trigger.pathPatterns.join(", ")} onChange={(event) => setEditing({ ...editing, trigger: { ...editing.trigger, pathPatterns: parseList(event.target.value) } })} /></label>
              <label className="skill-field"><span>任务关键词</span><input placeholder="搜索, 打开结果" value={editing.trigger.keywords.join(", ")} onChange={(event) => setEditing({ ...editing, trigger: { ...editing.trigger, keywords: parseList(event.target.value) } })} /></label>
              <div className="skill-editor-note"><Settings2 size={14} /><span>{editing.steps.length} 个声明式操作步骤将保持不变。</span></div>
              <button type="submit" className="skill-primary-command" disabled={busy || !editing.name.trim()}><Save size={15} />保存修改</button>
            </form>
          ) : selectedSkill ? (
            <div className="skill-detail">
              <div className="skill-detail-heading">
                <div><span className="section-kicker">技能详情</span><strong>{selectedSkill.name}</strong></div>
                <div className="skill-icon-actions">
                  <IconButton label="编辑技能" disabled={busy} onClick={() => setEditing({ ...selectedSkill, trigger: { ...selectedSkill.trigger } })}><Pencil size={14} /></IconButton>
                  <IconButton label="导出技能" disabled={busy} onClick={() => onExport(selectedSkill)}><FileOutput size={14} /></IconButton>
                  <IconButton label="删除技能" danger disabled={busy} onClick={() => onDelete(selectedSkill)}><Trash2 size={14} /></IconButton>
                </div>
              </div>
              <p className="skill-description">{selectedSkill.description || "没有说明。"}</p>
              <div className="skill-summary-line">
                <span className={`skill-status ${selectedSkill.status}`}>{skillStatusLabel(selectedSkill.status)}</span>
                <span className={`skill-risk ${selectedSkill.risk}`}>{skillRiskLabel(selectedSkill.risk)}</span>
                <span>v{selectedSkill.version}</span>
                <label className="skill-toggle"><input type="checkbox" checked={selectedSkill.status === "enabled"} disabled={busy} onChange={(event) => onStatus(selectedSkill, event.target.checked ? "enabled" : "disabled")} /><span aria-hidden="true" /><b>{selectedSkill.status === "enabled" ? "启用" : "停用"}</b></label>
              </div>
              <section className="skill-section">
                <h3>触发条件</h3>
                <div className="skill-trigger-groups">
                  <div><span>域名</span><p>{selectedSkill.trigger.hosts.join(" · ") || "不限"}</p></div>
                  <div><span>路径</span><p>{selectedSkill.trigger.pathPatterns.join(" · ") || "不限"}</p></div>
                  <div><span>关键词</span><p>{selectedSkill.trigger.keywords.join(" · ") || "不限"}</p></div>
                </div>
              </section>
              <section className="skill-section">
                <h3>操作步骤</h3>
                <ol className="skill-step-list">
                  {selectedSkill.steps.map((step) => <li key={step.id}><span>{step.label}</span><small>{step.method} · {skillRiskLabel(step.risk)}</small></li>)}
                </ol>
              </section>
              <section className="skill-section skill-run-section">
                <div className="skill-section-title"><h3>运行技能</h3><span>{selectedSkill.stats.runCount > 0 ? `${Math.round((selectedSkill.stats.successCount / selectedSkill.stats.runCount) * 100)}% 成功` : "尚未运行"}</span></div>
                {selectedSkill.inputs.length === 0 ? <p className="skill-muted">此技能不需要输入参数。</p> : (
                  <div className="skill-run-inputs">
                    {selectedSkill.inputs.map((input) => input.type === "boolean" ? (
                      <label className="skill-check-field" key={input.name}><input type="checkbox" checked={runInputs[input.name] === true} onChange={(event) => setRunInputs({ ...runInputs, [input.name]: event.target.checked })} /><span>{input.label}{input.required ? " *" : ""}</span></label>
                    ) : (
                      <label className="skill-field" key={input.name}><span>{input.label}{input.required ? " *" : ""}</span><input type={input.sensitive ? "password" : input.type} value={String(runInputs[input.name] ?? "")} autoComplete="off" onChange={(event) => setRunInputs({ ...runInputs, [input.name]: input.type === "number" && event.target.value !== "" ? Number(event.target.value) : event.target.value })} /></label>
                    ))}
                  </div>
                )}
                {runNeedsConfirmation && (
                  <label className="skill-confirmation"><ShieldAlert size={16} /><input type="checkbox" checked={runConfirmed} onChange={(event) => setRunConfirmed(event.target.checked)} /><span>此技能包含会改变网页状态的操作，我确认运行。</span></label>
                )}
                <button type="button" className="skill-primary-command" disabled={busy || selectedSkill.status !== "enabled" || requiredInputsMissing || (runNeedsConfirmation && !runConfirmed)} onClick={() => onRun(selectedSkill, runInputs, runConfirmed)}>
                  {busy ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}
                  {selectedSkill.status === "enabled" ? "运行技能" : "启用后运行"}
                </button>
              </section>
            </div>
          ) : null}
        </div>
      )}

      {tab === "learning" && (
        <div className="skill-drawer-content">
          <div className="skill-view-heading"><div><strong>学习记录</strong><span>从完成的网页操作生成可编辑技能</span></div></div>
          <div className="trace-list">
            {traces.filter((trace) => trace.status !== "discarded").length === 0 ? <div className="skill-empty"><Sparkles size={22} /><strong>没有待处理记录</strong><span>浏览器会在任务中记录可复用的操作逻辑。</span></div> : traces.filter((trace) => trace.status !== "discarded").map((trace) => (
              <div className="trace-row" key={trace.id}>
                <div className="trace-row-main">
                  <span className={`trace-status ${trace.status}`}>{traceStatusLabel(trace.status)}</span>
                  <strong>{trace.title}</strong>
                  <span>{trace.host ?? "未知网站"} · {trace.operationCount} 次操作 · {formatRelativeTime(trace.updatedAt)}</span>
                </div>
                <div className="trace-actions">
                  {["recording", "ready"].includes(trace.status) && <button type="button" className="compact-command primary" disabled={busy || trace.operationCount === 0} onClick={() => onLearnTrace(trace.id)}><Sparkles size={14} />生成草稿</button>}
                  {trace.status === "learned" && trace.draftSkillId && <button type="button" className="compact-command" onClick={() => openSkill(trace.draftSkillId!)}><ChevronRight size={14} />查看技能</button>}
                  {trace.status !== "learned" && <IconButton label="忽略学习记录" danger disabled={busy} onClick={() => onDiscardTrace(trace.id)}><Trash2 size={14} /></IconButton>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === "runs" && (
        <div className="skill-drawer-content">
          <div className="skill-view-heading"><div><strong>技能运行</strong><span>查看当前进度与已积累的熟练度</span></div></div>
          {currentRun ? (
            <section className={`current-skill-run ${currentRun.status}`}>
              <div className="current-run-heading">
                {currentRun.status === "running" ? <LoaderCircle className="spin" size={17} /> : currentRun.status === "done" ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
                <div><strong>{currentRun.skillName}</strong><span>{skillRunStatusLabel(currentRun.status)}</span></div>
                <b>{currentRun.currentStep}/{currentRun.totalSteps}</b>
              </div>
              <div className="skill-run-progress"><span style={{ width: `${currentRun.totalSteps > 0 ? Math.min(100, (currentRun.currentStep / currentRun.totalSteps) * 100) : 0}%` }} /></div>
              <p>{currentRun.detail}</p>
            </section>
          ) : <div className="skill-empty compact"><Clock3 size={20} /><strong>当前没有技能在运行</strong></div>}
          <div className="skill-history-heading"><strong>运行统计</strong><span>按最近运行排序</span></div>
          <div className="skill-run-history">
            {skills.filter((skill) => skill.stats.runCount > 0).sort((a, b) => Date.parse(b.stats.lastRunAt ?? "") - Date.parse(a.stats.lastRunAt ?? "")).map((skill) => (
              <button type="button" className="skill-run-row" key={skill.id} onClick={() => openSkill(skill.id)}>
                <span className="run-history-icon"><History size={15} /></span>
                <span className="run-history-copy"><strong>{skill.name}</strong><span>{skill.stats.successCount}/{skill.stats.runCount} 成功 · 平均 {formatDuration(skill.stats.averageDurationMs)}</span></span>
                <span className="run-history-time">{formatRelativeTime(skill.stats.lastRunAt)}</span>
                <ChevronRight size={14} />
              </button>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

function App() {
  const bridge = window.codexBrowser;
  const isPreview = !bridge;
  const [state, setState] = useState<AppState | null>(() => isPreview ? previewState : null);
  const [address, setAddress] = useState(() => isPreview ? previewState.url : "");
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [tabBusy, setTabBusy] = useState(false);
  const [assistanceNote, setAssistanceNote] = useState("");
  const [dialogInput, setDialogInput] = useState("");
  const [skillDrawerOpen, setSkillDrawerOpen] = useState(false);
  const [skillNotice, setSkillNotice] = useState<string | null>(null);
  const browserSlot = useRef<HTMLDivElement>(null);
  const addressFocused = useRef(false);

  useEffect(() => {
    if (!bridge) return;
    let disposed = false;
    const applyState = (next: AppState) => {
      if (disposed) return;
      setState(next);
      if (!addressFocused.current) setAddress(next.url);
    };

    let unsubscribe: () => void = () => undefined;
    try {
      unsubscribe = bridge.subscribeState(applyState);
    } catch (subscriptionError) {
      setError(subscriptionError instanceof Error ? subscriptionError.message : String(subscriptionError));
    }

    void bridge.getState()
      .then(applyState)
      .catch((stateError) => {
        if (!disposed) {
          setError(`无法连接桌面浏览器：${stateError instanceof Error ? stateError.message : String(stateError)}`);
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
  const waitingAssistance = viewState.assistance?.status === "waiting_user"
    && viewState.assistance.tabId === viewState.activeTabId
    ? viewState.assistance
    : null;
  const activeAuthPrompt = viewState.authPrompt?.tabId === viewState.activeTabId ? viewState.authPrompt : null;

  useEffect(() => {
    setAssistanceNote(waitingAssistance?.note ?? "");
  }, [waitingAssistance?.id]);

  useEffect(() => {
    setDialogInput(blockingDialog?.defaultValue ?? "");
  }, [blockingDialog?.id]);

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
  }, [bridge, desktopReady, skillDrawerOpen, viewState.activeTabId]);

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
      setError(operationError instanceof Error ? operationError.message : String(operationError));
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
      setError(operationError instanceof Error ? operationError.message : String(operationError));
    }
  }

  async function invokeTabCommand(operation: (desktopBridge: DesktopBridge) => Promise<unknown>): Promise<void> {
    if (!bridge || !state || tabBusy) return;
    setError(null);
    setTabBusy(true);
    try {
      await operation(bridge);
    } catch (operationError) {
      setError(operationError instanceof Error ? operationError.message : String(operationError));
    } finally {
      setTabBusy(false);
    }
  }

  const submitAddress = (event: FormEvent) => {
    event.preventDefault();
    if (!desktopReady || !address.trim()) return;
    void invokeDesktop("navigate", (desktopBridge) => desktopBridge.navigate(address));
  };

  const applyBrowserSkill = (skill: BrowserSkill) => {
    setState((current) => {
      if (!current) return current;
      const exists = current.browserSkills.some((item) => item.id === skill.id);
      const browserSkills = exists
        ? current.browserSkills.map((item) => item.id === skill.id ? skill : item)
        : [skill, ...current.browserSkills];
      return {
        ...current,
        browserSkills,
        storage: { ...current.storage, browserSkillCount: browserSkills.length },
      };
    });
  };

  const removeBrowserSkill = (skillId: string) => {
    setState((current) => {
      if (!current) return current;
      const browserSkills = current.browserSkills.filter((item) => item.id !== skillId);
      return {
        ...current,
        browserSkills,
        storage: { ...current.storage, browserSkillCount: browserSkills.length },
      };
    });
  };

  const removeBrowserSkillTrace = (traceId: string) => {
    setState((current) => {
      if (!current) return current;
      const browserSkillTraces = current.browserSkillTraces.filter((trace) => trace.id !== traceId);
      return {
        ...current,
        browserSkillTraces,
        storage: { ...current.storage, browserSkillTraceCount: browserSkillTraces.length },
      };
    });
  };

  const saveBrowserSkill = (skill: BrowserSkill) => {
    setSkillNotice(null);
    if (isPreview) {
      applyBrowserSkill(skill);
      setSkillNotice("技能修改已保存（预览）");
      return;
    }
    void invokeDesktop("skill-save", (desktopBridge) => desktopBridge.saveBrowserSkill(skill), (savedSkill) => {
      applyBrowserSkill(savedSkill);
      setSkillNotice("技能修改已保存");
    });
  };

  const changeBrowserSkillStatus = (skill: BrowserSkill, status: BrowserSkillStatus) => {
    setSkillNotice(null);
    if (isPreview) {
      applyBrowserSkill({ ...skill, status, updatedAt: new Date().toISOString() });
      setSkillNotice(status === "enabled" ? "技能已启用（预览）" : "技能已停用（预览）");
      return;
    }
    void invokeDesktop("skill-status", (desktopBridge) => desktopBridge.setBrowserSkillStatus(skill.id, status), (savedSkill) => {
      applyBrowserSkill(savedSkill);
      setSkillNotice(status === "enabled" ? "技能已启用" : "技能已停用");
    });
  };

  const deleteBrowserSkill = (skill: BrowserSkill) => {
    if (!window.confirm(`删除浏览器技能“${skill.name}”？此操作不会删除原始任务记录。`)) return;
    setSkillNotice(null);
    if (isPreview) {
      removeBrowserSkill(skill.id);
      setSkillNotice("技能已删除（预览）");
      return;
    }
    void invokeDesktop("skill-delete", (desktopBridge) => desktopBridge.deleteBrowserSkill(skill.id), () => {
      removeBrowserSkill(skill.id);
      setSkillNotice("技能已删除");
    });
  };

  const importBrowserSkill = () => {
    setSkillNotice(null);
    if (isPreview) {
      const template = previewState.browserSkills[0];
      const importedSkill: BrowserSkill = {
        ...template,
        id: `preview-imported-${Date.now()}`,
        name: "导入的通用网页检索",
        description: "从 .cbskill 文件导入的浏览器工作流，默认停用以便先检查内容。",
        status: "disabled",
        source: "imported",
        stats: { runCount: 0, successCount: 0, failureCount: 0, averageDurationMs: 0 },
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      applyBrowserSkill(importedSkill);
      setSkillNotice("技能已导入并保持停用（预览）");
      return;
    }
    void invokeDesktop("skill-import", (desktopBridge) => desktopBridge.importBrowserSkill(), (importedSkill) => {
      if (!importedSkill) return;
      applyBrowserSkill(importedSkill);
      setSkillNotice("技能已导入，请检查后启用");
    });
  };

  const exportBrowserSkill = (skill: BrowserSkill) => {
    setSkillNotice(null);
    if (isPreview) {
      setSkillNotice(`已导出“${skill.name}”（预览）`);
      return;
    }
    void invokeDesktop("skill-export", (desktopBridge) => desktopBridge.exportBrowserSkill(skill.id), (exported) => {
      if (exported) setSkillNotice(`已导出“${skill.name}”`);
    });
  };

  const learnBrowserSkillTrace = (traceId: string) => {
    setSkillNotice(null);
    if (isPreview) {
      const trace = viewState.browserSkillTraces.find((item) => item.id === traceId);
      if (!trace) return;
      const createdAt = new Date().toISOString();
      const draftSkill: BrowserSkill = {
        schemaVersion: 1,
        id: `preview-learned-${Date.now()}`,
        name: trace.title,
        description: `从 ${trace.host ?? "当前网站"} 的 ${trace.operationCount} 次操作中生成，请检查触发条件和参数。`,
        status: "draft",
        risk: "interaction",
        trigger: { hosts: trace.host ? [trace.host] : [], pathPatterns: [], keywords: [] },
        inputs: [],
        steps: [{ id: "learned-step", label: "等待页面稳定", method: "browser.wait", params: { condition: "idle" }, risk: "read_only" }],
        stats: { runCount: 0, successCount: 0, failureCount: 0, averageDurationMs: 0 },
        source: "learned",
        sourceTraceId: trace.id,
        version: 1,
        createdAt,
        updatedAt: createdAt,
      };
      applyBrowserSkill(draftSkill);
      setState((current) => current ? {
        ...current,
        browserSkillTraces: current.browserSkillTraces.map((item) => item.id === traceId ? { ...item, status: "learned", draftSkillId: draftSkill.id, updatedAt: createdAt } : item),
      } : current);
      setSkillNotice("已生成可编辑技能草稿（预览）");
      return;
    }
    void invokeDesktop("skill-learn", (desktopBridge) => desktopBridge.createBrowserSkillFromTrace(traceId), (createdSkill) => {
      applyBrowserSkill(createdSkill);
      setSkillNotice("已生成可编辑技能草稿");
    });
  };

  const discardBrowserSkillTrace = (traceId: string) => {
    setSkillNotice(null);
    if (isPreview) {
      removeBrowserSkillTrace(traceId);
      setSkillNotice("学习记录已忽略（预览）");
      return;
    }
    void invokeDesktop("skill-discard", (desktopBridge) => desktopBridge.discardBrowserSkillTrace(traceId), () => {
      removeBrowserSkillTrace(traceId);
      setSkillNotice("学习记录已忽略");
    });
  };

  const runBrowserSkill = (skill: BrowserSkill, inputs: Record<string, string | number | boolean>, confirmed: boolean) => {
    setSkillNotice(null);
    if (isPreview) {
      const startedAt = new Date().toISOString();
      setState((current) => current ? {
        ...current,
        browserSkillRun: {
          id: `preview-run-${Date.now()}`,
          skillId: skill.id,
          skillName: skill.name,
          status: "running",
          currentStep: 1,
          totalSteps: skill.steps.length,
          detail: `已接收 ${Object.keys(inputs).length} 个参数，正在验证当前页面`,
          startedAt,
        },
      } : current);
      setSkillNotice("技能已开始运行（预览）");
      return;
    }
    void invokeDesktop("skill-run", (desktopBridge) => desktopBridge.runBrowserSkill(skill.id, inputs, confirmed), (run) => {
      setState((current) => current ? { ...current, browserSkillRun: run } : current);
      setSkillNotice("技能已开始运行");
    });
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
  const hasActiveWork = viewState.isLoading
    || ["running", "waiting_user", "downloading", "parsing"].includes(viewState.runtimeStatus)
    || viewState.tasks.some((item) => item.status === "queued" || item.status === "running" || item.status === "waiting_user");
  const healthChecking = busyAction === "check-session" || busyAction === "complete-auth" || viewState.sessionHealth.status === "checking";

  return (
    <div className={`app-shell${skillDrawerOpen ? " skill-drawer-open" : ""}`}>
      <header className="topbar">
        <div className="brand" title="Codex Browser">
          <div className="brand-mark"><img src={appIconUrl} alt="" /></div>
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

        <div className={`runtime-pill ${statusClass}`} title={viewState.currentAction}>
          <span className="runtime-dot" />
          <span>{statusLabel(viewState.runtimeStatus)}</span>
        </div>
        <div className={`skill-toolbar-control${skillDrawerOpen ? " open" : ""}`}>
          <IconButton label={skillDrawerOpen ? "关闭浏览器技能库" : "打开浏览器技能库"} onClick={() => setSkillDrawerOpen((open) => !open)}><BrainCircuit size={16} /></IconButton>
          {viewState.browserSkillTraces.some((trace) => ["recording", "ready"].includes(trace.status)) && <span className="skill-toolbar-badge" aria-label="有待学习的操作记录">{viewState.browserSkillTraces.filter((trace) => ["recording", "ready"].includes(trace.status)).length}</span>}
        </div>
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
          <div className="storage-status" title={`本地记录：${viewState.storage.taskCount} 个任务、${viewState.storage.downloadCount} 个下载、${viewState.storage.documentCount} 篇文献、${viewState.storage.browserSkillCount} 个技能`}>
            <HardDrive size={15} />
            <strong>{formatSavedAt(viewState.storage.lastSavedAt)}</strong>
            <span>{viewState.storage.taskCount} 任务 · {viewState.storage.downloadCount} 下载 · {viewState.storage.documentCount} 文献 · {viewState.storage.browserSkillCount} 技能</span>
          </div>
          <div className="backup-status" title={viewState.sessionHealth.encryptedBackupAvailable ? "Cookie 会话已有本机加密备份" : "浏览器 Profile 将持续保存在本机"}>
            <Cookie size={14} />
            <span>{viewState.sessionHealth.encryptedBackupAvailable ? "会话备份已加密" : "Profile 本地持久化"}</span>
          </div>
          <IconButton
            label={viewState.credentialVault.savedSiteCount > 0
              ? `清除 ${viewState.credentialVault.savedSiteCount} 个站点的已保存登录信息`
              : viewState.credentialVault.encryptionAvailable
                ? "当前没有已保存的登录信息"
                : "Windows 加密不可用，无法保存登录信息"}
            disabled={controlsDisabled || viewState.credentialVault.savedSiteCount === 0}
            onClick={() => {
              if (!window.confirm("清除全部由 Codex Browser 加密保存的登录信息？")) return;
              void invokeDesktop(
                "clear-logins",
                (desktopBridge) => desktopBridge.clearSavedLogins(),
                (credentialVault) => setState((current) => current ? { ...current, credentialVault } : current),
              );
            }}
          >
            <KeyRound className={viewState.credentialVault.savedSiteCount > 0 ? "credential-saved" : ""} size={15} />
          </IconButton>
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
          {blockingDialog.type === "prompt" && (
            <input
              className="blocker-input"
              type={blockingDialog.sensitive ? "password" : "text"}
              aria-label={blockingDialog.sensitive ? "网页请求的敏感输入" : "网页请求的输入"}
              placeholder={blockingDialog.sensitive ? "敏感输入不会显示" : "输入回复"}
              autoComplete="off"
              maxLength={2_000}
              value={dialogInput}
              disabled={controlsDisabled}
              onChange={(event) => setDialogInput(event.target.value)}
            />
          )}
          <div className="blocking-actions">
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
          </div>
        </section>
      ) : waitingAssistance ? (
        <section className="blocking-banner assistance" role="alert">
          <MessageSquareText size={18} />
          <div className="blocking-copy">
            <strong>{waitingAssistance.title}</strong>
            <span title={waitingAssistance.detail}>{waitingAssistance.detail}</span>
          </div>
          <input
            className="blocker-input assistance-note"
            type="text"
            aria-label="给 Codex 的可选备注"
            title="此备注会返回给 Codex"
            placeholder="备注（将返回 Codex，可选）"
            maxLength={1_000}
            value={assistanceNote}
            disabled={controlsDisabled}
            onChange={(event) => setAssistanceNote(event.target.value)}
          />
          <div className="blocking-actions">
            <button
              type="button"
              className="blocker-button secondary"
              disabled={controlsDisabled}
              onClick={() => void invokeDesktop(
                "respond-assistance",
                (desktopBridge) => desktopBridge.respondAssistance(
                  waitingAssistance.id,
                  "unable",
                  assistanceNote.trim() || undefined,
                ),
              )}
            >
              <X size={14} />
              无法完成
            </button>
            <button
              type="button"
              className="blocker-button primary"
              disabled={controlsDisabled}
              onClick={() => void invokeDesktop(
                "respond-assistance",
                (desktopBridge) => desktopBridge.respondAssistance(
                  waitingAssistance.id,
                  "completed",
                  assistanceNote.trim() || undefined,
                ),
              )}
            >
              {busyAction === "respond-assistance" ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}
              已完成
            </button>
          </div>
        </section>
      ) : activeAuthPrompt ? (
        <section className="blocking-banner auth" role="alert">
          <AlertTriangle size={18} />
          <div className="blocking-copy">
            <strong>{activeAuthPrompt.title}</strong>
            <span title={activeAuthPrompt.detail}>{activeAuthPrompt.detail}</span>
          </div>
          <div className="blocking-actions">
            {activeAuthPrompt.reason === "login" && (
              <button
                type="button"
                className="blocker-button secondary"
                disabled={controlsDisabled || !viewState.credentialVault.encryptionAvailable}
                title={viewState.credentialVault.encryptionAvailable ? "使用 Windows 加密保存当前表单，并提交登录" : "Windows 加密不可用"}
                onClick={() => void invokeDesktop(
                  "save-login",
                  (desktopBridge) => desktopBridge.saveAndSubmitLogin(activeAuthPrompt.id),
                  (credentialVault) => setState((current) => current ? { ...current, credentialVault } : current),
                )}
              >
                {busyAction === "save-login" ? <LoaderCircle className="spin" size={14} /> : <KeyRound size={14} />}
                {viewState.credentialVault.activeSiteSaved ? "更新并登录" : "保存并登录"}
              </button>
            )}
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
          </div>
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

      <div className={`workspace${skillDrawerOpen ? " has-skill-drawer" : ""}`}>
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
        {skillDrawerOpen && (
          <BrowserSkillDrawer
            skills={viewState.browserSkills}
            traces={viewState.browserSkillTraces}
            currentRun={viewState.browserSkillRun}
            busy={busyAction !== null}
            notice={skillNotice}
            onClose={() => setSkillDrawerOpen(false)}
            onImport={importBrowserSkill}
            onSave={saveBrowserSkill}
            onStatus={changeBrowserSkillStatus}
            onDelete={deleteBrowserSkill}
            onExport={exportBrowserSkill}
            onLearnTrace={learnBrowserSkillTrace}
            onDiscardTrace={discardBrowserSkillTrace}
            onRun={runBrowserSkill}
          />
        )}
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
