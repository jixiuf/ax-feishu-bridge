import { detectCodeLanguage, decodeTextFile, detectImageMime, type FeishuImageInput, isSupportedImageMime, isSupportedTextFile } from "./attachments.ts";
import { buildModelCard, buildResumeCard, buildThinkingCard } from "./cards.ts";
import type { ConversationRuntime } from "./runtime.ts";
import { claimFeishuMessage, markFeishuMessage } from "./dedupe-store.ts";
import { debugLog } from "./debug.ts";
import { loadConfig } from "./config.ts";
import {
  clearRuntimeOverrides,
  formatRuntimeConfig,
  getRuntimeOverrides,
  setRuntimeConfig,
} from "./runtime-config.ts";
import { conversationKey, conversationLabel, buildPromptWithQuote, getCommandList, normalizeForDedupe, parseBotCommand, parseMessageInput, pruneRecentMap } from "./messages.ts";
import { formatReplyFooter, formatTokenCount } from "./rich-text.ts";
import { ReplyCard } from "./reply-card.ts";
import { FeishuDelivery } from "./delivery.ts";
import {
  DEFAULT_QUESTION_TIMEOUT_MS,
  formatQuestionMessage,
  parseQuestionAnswer,
  type ParsedQuestionAnswer,
  type QuestionOption,
} from "./questionnaire.ts";
import type { FeishuBridgeStore } from "./bridge-store.ts";
import type { FeishuTransport } from "./transport.ts";
import type { FeishuMessage } from "./types.ts";

const CONTENT_DEDUPE_TTL_MS = 5_000;

/**
 * 飞书网关（daemon）管理能力，由适配器（src/adapters/pi/index.ts）注入。
 * 供飞书内 /feishu restart|stop|start|status 命令调用。
 */
export type FeishuGatewayOps = {
  restart(): Promise<{ ok: boolean; message?: string }>;
  stop(): Promise<{ ok: boolean; message?: string }>;
  start(): Promise<{ ok: boolean; message?: string }>;
  status(): Promise<{ ok: boolean; message?: string }>;
  reload(): Promise<{ ok: boolean; message?: string }>;
  reloadall(): Promise<{ ok: boolean; message?: string }>;
};

export class FeishuMessageHandler {
  private readonly seen = new Set<string>();
  private readonly recentContent = new Map<string, number>();
  private readonly conversations: ConversationRuntime;
  private readonly getTransport: () => FeishuTransport | undefined;
  private readonly bridgeStore?: FeishuBridgeStore;
  private readonly feishuOps?: FeishuGatewayOps;
  private readonly delivery?: FeishuDelivery;

  /** 待答问题状态（等待飞书用户回复；目标用户的下一条文本被拦截为答案） */
  private pendingQuestion: {
    key: string;
    userId: string;
    options: QuestionOption[];
    multiSelect: boolean;
    resolve: (answer: ParsedQuestionAnswer | null) => void;
  } | null = null;

  /** 最近活跃会话 key 及每个会话的最后发送者 open_id（用于 group 场景定位提问对象） */
  private lastActiveKey: string | undefined;
  private readonly lastSenderByKey = new Map<string, string>();

  constructor(
    conversations: ConversationRuntime,
    getTransport: () => FeishuTransport | undefined,
    bridgeStore?: FeishuBridgeStore,
    feishuOps?: FeishuGatewayOps,
    delivery?: FeishuDelivery,
  ) {
    this.conversations = conversations;
    this.getTransport = getTransport;
    this.bridgeStore = bridgeStore;
    this.feishuOps = feishuOps;
    this.delivery = delivery;
  }

  reset() {
    this.seen.clear();
    this.recentContent.clear();
    this.cancelPendingQuestion();
    this.lastSenderByKey.clear();
    this.lastActiveKey = undefined;
  }

  async handle(msg: FeishuMessage) {
    const transport = this.getTransport();
    if (!transport) return;

    try {
      if (this.seen.has(msg.messageId)) return;
      if (!(await claimFeishuMessage(msg.messageId))) return;
      this.seen.add(msg.messageId);
      if (this.seen.size > 2000) this.seen.clear();

      const cfg = loadConfig();
      const parsed = parseMessageInput(msg, transport.getBotOpenId(), {
        parseInteractiveCards: cfg?.parseInteractiveCards !== false,
      });
      let text = parsed.text || "";
      const key = conversationKey(msg);
      this.bridgeStore?.bindConversation(key, msg);
      // 记录最近活跃会话与最后发送者（供外部桥定位提问对象）
      this.lastActiveKey = key;
      this.lastSenderByKey.set(key, msg.senderOpenId);
      if (this.lastSenderByKey.size > 200) this.lastSenderByKey.clear();

      // 展开引用/回复的父消息（告警卡片场景）
      let quoted: { msgType: string; text: string } | null = null;
      if (cfg?.includeQuotedMessage !== false && (msg.parentId || msg.rootId)) {
        const q = await transport.getQuotedContext(
          msg,
          transport.getBotOpenId(),
          cfg?.quotedMessageMaxChars ?? 8000,
        );
        if (q?.text) {
          quoted = { msgType: q.msgType, text: q.text };
          for (const a of q.attachments || []) parsed.attachments.push(a);
        }
      }

      debugLog("feishu.handler.parsed", {
        messageId: msg.messageId,
        key,
        chatMode: msg.chatMode,
        threadId: msg.threadId || msg.rootId || msg.parentId,
        textLength: text.length,
        source: parsed.source,
        quoted: Boolean(quoted),
        attachments: parsed.attachments.map((item) => ({
          kind: item.kind,
          fileKey: item.fileKey,
          fileName: item.fileName,
        })),
      });

      if (!parsed.attachments.length) {
        if (!text && !quoted) {
          await markFeishuMessage(msg.messageId, "ignored");
          return;
        }
        // 待答问题拦截：pendingQuestion 的目标用户文本作为答案消费，不进入模型/命令
        if (text && this.pendingQuestion && this.pendingQuestion.userId === msg.senderOpenId) {
          const consumed = this.answerPendingQuestion(msg.senderOpenId, text);
          if (consumed) {
            await markFeishuMessage(msg.messageId, "replied");
            return;
          }
        }
        if (text) {
          const handled = await this.handleCommand(msg, key, text);
          if (handled) {
            await markFeishuMessage(msg.messageId, "replied");
            return;
          }
        }
      }

      if (this.isDuplicateContent(msg, key, text, parsed.attachments)) {
        await markFeishuMessage(msg.messageId, "ignored");
        return;
      }

      const model = await this.conversations.getSelectedModel(key);
      const modelSupportsImage = Boolean(model?.supportsImage);
      debugLog("feishu.handler.model", {
        messageId: msg.messageId,
        key,
        model: model ? `${model.provider}/${model.id}` : undefined,
        modelSupportsImage,
      });

      const processed = await this.processAttachments(msg, parsed.attachments, modelSupportsImage);
      const { imageInputs, fileSections, downloadErrors, skippedImageCount } = processed;

      if (skippedImageCount > 0 && imageInputs.length === 0 && !fileSections.length && !text.trim()) {
        await transport.replyText(
          msg.messageId,
          "当前模型不支持图片解析。请先发送 /model 并切换到支持图片的模型后，再重发图片。",
        );
        await markFeishuMessage(msg.messageId, "replied");
        return;
      }

      if (downloadErrors.length && !imageInputs.length && !fileSections.length && !text.trim()) {
        await transport.replyText(msg.messageId, `没有可处理的内容：${downloadErrors.join("；")}`);
        await markFeishuMessage(msg.messageId, "replied");
        return;
      }

      const basePrompt = buildPrompt(msg, text, fileSections, imageInputs, skippedImageCount, modelSupportsImage, downloadErrors);
      const prompt = buildPromptWithQuote(basePrompt, quoted);
      // 单卡：全程 header；流式参数来自 config/env
      const useStreaming = cfg?.streamingReply !== false;
      const card = new ReplyCard(key, msg.messageId, transport, {
        enabled: useStreaming,
        printFrequencyMs: cfg?.streamPrintFrequencyMs,
        printStep: cfg?.streamPrintStep,
        pushIntervalMs: cfg?.streamPushIntervalMs,
      });
      await card.start();

      await this.conversations.promptWithImages(
        key,
        prompt,
        imageInputs,
        async (reply) => {
          const footer = await this.buildReplyFooter(key);
          await card.completeWithAnswer(reply || "（无内容）", footer);
        },
        card,
        useStreaming ? (delta) => card.append(delta) : undefined,
      );
      await markFeishuMessage(msg.messageId, "replied");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugLog("feishu.handler.error", { messageId: msg.messageId, error: message });
      await markFeishuMessage(msg.messageId, "failed", message);
      await this.getTransport()?.replyText(msg.messageId, `Pi error: ${message}`);
    }
  }

  /**
   * 通过飞书向指定用户提问，挂起等待回复（数字/文字/0 取消）。
   * 返回 null 表示超时 / 被取消 / 桥接不可用。
   */
  async askQuestion(opts: {
    key?: string;
    userId: string;
    question: string;
    header?: string;
    options: QuestionOption[];
    multiSelect?: boolean;
    index?: number;
    total?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<ParsedQuestionAnswer | null> {
    // 发送问题到飞书（无会话路由则仍等待回复，便于 group 场景降级）
    if (opts.key) {
      await this.sendQuestionMessage(opts.key, formatQuestionMessage(opts));
    }

    // 上一个未完成的问题先取消
    this.cancelPendingQuestion();

    return new Promise((resolve) => {
      const timeoutMs = opts.timeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS;
      let settled = false;
      let pending: NonNullable<FeishuMessageHandler["pendingQuestion"]>;
      let timer: NodeJS.Timeout | undefined;

      const settle = (answer: ParsedQuestionAnswer | null): void => {
        if (settled) return;
        settled = true;
        if (this.pendingQuestion === pending) this.pendingQuestion = null;
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        resolve(answer);
      };

      const onAbort = (): void => settle(null);

      timer = setTimeout(() => {
        if (opts.key) void this.sendQuestionMessage(opts.key, "⏰ 等待回复超时，问题已取消");
        settle(null);
      }, timeoutMs);

      pending = {
        key: opts.key ?? "",
        userId: opts.userId,
        options: opts.options,
        multiSelect: opts.multiSelect ?? false,
        resolve: settle,
      };
      this.pendingQuestion = pending;
      opts.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * 尝试把飞书文本消息作为待答问题的答案消费。
   * 返回 true 表示已消费（消息不再进入队列/模型）。
   */
  answerPendingQuestion(userId: string, text: string): boolean {
    const pending = this.pendingQuestion;
    if (!pending || pending.userId !== userId) return false;

    const parsed = parseQuestionAnswer(text, pending.options, pending.multiSelect);

    if (parsed.kind === "invalid") {
      // 数字越界或空文本 → 提示重发，不结束等待
      const hint = pending.multiSelect
        ? "⚠️ 请输入有效选项数字（如 1,3），或直接输入自定义文字；回复 0 取消"
        : "⚠️ 请输入有效选项数字，或直接输入自定义文字；回复 0 取消";
      if (pending.key) void this.sendQuestionMessage(pending.key, hint);
      return true;
    }

    if (parsed.kind === "cancel") {
      if (pending.key) void this.sendQuestionMessage(pending.key, "✖️ 问题已取消");
    }
    pending.resolve(parsed);
    return true;
  }

  /** 取消当前待答问题（resolve null，不消费任何消息） */
  cancelPendingQuestion(): void {
    const pending = this.pendingQuestion;
    if (!pending) return;
    this.pendingQuestion = null;
    pending.resolve(null);
  }

  /** 最近活跃会话 key 的最后发送者 open_id（无则 null） */
  getLastSender(key?: string): string | null {
    const k = key || this.lastActiveKey;
    return k ? (this.lastSenderByKey.get(k) ?? null) : null;
  }

  private async sendQuestionMessage(key: string, text: string): Promise<void> {
    const route = this.bridgeStore?.getRoute(key);
    if (!route || !this.delivery) return;
    try {
      await this.delivery.send(route, text);
    } catch (error) {
      debugLog("feishu.question.send_failed", {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleCommand(msg: FeishuMessage, key: string, text: string) {
    const command = parseBotCommand(text);
    if (!command) return false;

    const transport = this.getTransport();
    if (!transport) return true;

    if (command.name === "new") {
      await this.conversations.newConversation(key, async (reply) => {
        await transport.replyText(msg.messageId, reply);
      });
      return true;
    }

    if (command.name === "model") {
      const models = await this.conversations.getAvailableModels();
      if (!models.length) {
        await transport.replyText(msg.messageId, "当前没有可用模型。请先在 Pi 里完成模型登录或 API Key 配置。");
        return true;
      }
      const currentModel = await this.conversations.getSelectedModel(key);
      await transport.replyCard(msg.messageId, buildModelCard(key, models, currentModel));
      return true;
    }

    if (command.name === "thinking") {
      const [currentModel, thinking] = await Promise.all([
        this.conversations.getSelectedModel(key),
        this.conversations.getThinkingStatus(key),
      ]);
      await transport.replyCard(msg.messageId, buildThinkingCard(key, currentModel, thinking));
      return true;
    }

    if (command.name === "resume") {
      const page = await this.conversations.listResumeSessions(key, "current", 0);
      await transport.replyCard(msg.messageId, buildResumeCard(page));
      return true;
    }

    if (command.name === "stop") {
      await this.conversations.stopConversation(key, async (reply) => {
        await transport.replyText(msg.messageId, reply);
      });
      return true;
    }

    if (command.name === "workspace") {
      await this.conversations.switchWorkspace(key, command.path, async (reply) => {
        await transport.replyText(msg.messageId, reply);
      });
      return true;
    }

    if (command.name === "status") {
      const st = this.conversations.getStatus(key);
      const ctx = await this.conversations.getContextStatus(key);
      const model = await this.conversations.getActualModel(key);
      const thinking = await this.conversations.getThinkingStatus(key);
      const ctxLine = ctx && ctx.tokens !== null && ctx.contextWindow
        ? `${(ctx.percent ?? 0).toFixed(1)}% / ${formatTokenCount(ctx.contextWindow)} (↑${formatTokenCount(ctx.tokens ?? 0)} tokens)`
        : "暂无数据（发送一条消息后才会显示）";
      // Token 明细（仅 Pi adapter 提供；Harness 阶段未接入 token-meter）
      const tokenLines: string[] = [];
      if (ctx && ctx.totalInput !== undefined) {
        tokenLines.push(
          `Token: in ${formatTokenCount(ctx.totalInput)} · out ${formatTokenCount(ctx.totalOutput ?? 0)} · cache ${formatTokenCount(ctx.totalCacheRead ?? 0)}`,
        );
        const detail: string[] = [];
        if (ctx.totalMessages !== undefined) detail.push(`消息 ${ctx.totalMessages}`);
        if (ctx.totalCost !== undefined) {
          detail.push(`花费 $${ctx.totalCost.toFixed(4)}`);
        }
        if (detail.length) tokenLines.push(detail.join(" · "));
      }
      const stateLine = st.hasActiveRun
        ? (st.activeStopped ? "⏹ 已停止" : "🟢 正在生成回复")
        : "⚪ 空闲";
      await transport.replyText(
        msg.messageId,
        [
          "📊 当前状态",
          "",
          `状态: ${stateLine}`,
          `目录: ${st.cwd}`,
          `模型: ${model}`,
          `thinking: ${thinking.available ? thinking.currentLevel || "(unknown)" : "(unavailable)"}`,
          `上下文: ${ctxLine}`,
          ...tokenLines,
        ].join("\n"),
      );
      return true;
    }

    if (command.name === "commands") {
      await transport.replyText(msg.messageId, `可用命令：\n${getCommandList()}`);
      return true;
    }

    if (command.name === "config") {
      if (msg.chatType !== "p2p") {
        await transport.replyText(
          msg.messageId,
          "为避免群聊成员意外修改机器人配置，/config 仅支持在与机器人的私聊中使用。",
        );
        return true;
      }
      if (command.clearTarget) {
        const cleared = clearRuntimeOverrides(command.clearTarget);
        if (cleared.ok === false) {
          await transport.replyText(msg.messageId, `❌ ${cleared.error}`);
          return true;
        }
        const cfg = loadConfig();
        await transport.replyText(
          msg.messageId,
          [
            command.clearTarget === "all" ? "已清除全部 runtime overrides" : `已清除 override: ${command.clearTarget}`,
            "",
            cfg ? formatRuntimeConfig(cfg, getRuntimeOverrides()) : "配置不可用",
          ].join("\n"),
        );
        return true;
      }
      if (command.key) {
        if (command.value === undefined || command.value === "") {
          await transport.replyText(
            msg.messageId,
            `用法: /config ${command.key} <value>\n或: /config clear ${command.key}`,
          );
          return true;
        }
        const set = setRuntimeConfig(command.key, command.value);
        if (set.ok === false) {
          await transport.replyText(msg.messageId, `❌ ${set.error}`);
          return true;
        }
        const cfg = loadConfig();
        await transport.replyText(
          msg.messageId,
          [
            `✅ 已更新 ${set.key} = ${Array.isArray(set.value) ? set.value.join(", ") : String(set.value)}`,
            "已热更新并落盘（runtime-overrides.json）",
            "",
            cfg ? formatRuntimeConfig(cfg, getRuntimeOverrides()) : "",
          ].filter(Boolean).join("\n"),
        );
        return true;
      }
      const cfg = loadConfig();
      await transport.replyText(
        msg.messageId,
        cfg ? formatRuntimeConfig(cfg, getRuntimeOverrides()) : "配置不可用（缺少 FEISHU_APP_ID/SECRET）",
      );
      return true;
    }

    // /feishu restart|stop|start|status — 飞书内管理网关（daemon）
    if (command.name === "feishu") {
      if (!this.feishuOps) {
        await transport.replyText(msg.messageId, "当前运行环境未提供 /feishu 网关管理能力。");
        return true;
      }
      const action = command.action || "status";
      const result = await this.feishuOps[action]();
      await transport.replyText(
        msg.messageId,
        result.ok ? `✅ ${result.message || action + " ok"}` : `❌ ${result.message || action + " failed"}`,
      );
      return true;
    }

    // /reload /reloadall — 重载扩展 / 广播重载（经 pi-hub 机制执行）
    if (command.name === "reload" || command.name === "reloadall") {
      if (!this.feishuOps?.reload || !this.feishuOps?.reloadall) {
        await transport.replyText(msg.messageId, "当前运行环境不支持 /reload /reloadall。");
        return true;
      }
      const result = command.name === "reload"
        ? await this.feishuOps.reload()
        : await this.feishuOps.reloadall();
      await transport.replyText(
        msg.messageId,
        result.ok ? `✅ ${result.message || command.name + " ok"}` : `❌ ${result.message || command.name + " failed"}`,
      );
      return true;
    }

    // /task <描述> — 用户要求以子任务（subagent）方式执行：
    // 注入 agent 上下文（agent 有 pi-hub 的 task_subagent 工具），由 agent 起子任务并执行；
    // 子任务进度/结果经 pi-hub 协调消息 notify 推送到飞书，用户全程可见。
    if (command.name === "task") {
      const text = (command.text || "").trim();
      if (!text) {
        await transport.replyText(msg.messageId, "用法: /task <任务描述>\n例: /task 查用户 545473 的 passgo 信息");
        return true;
      }
      await transport.replyText(
        msg.messageId,
        "🚀 收到，将以子任务方式执行。任务进度和结果会推送到这里，请稍候…",
      );
      await this.conversations.prompt(
        key,
        [
          "【用户要求以子任务(subagent)方式执行】",
          text,
          "",
          "请调用 task_subagent 工具执行（host 选择：线上查库/日志用 bj-vc-client-apm-01，代码/仓库分析用 ljmacjxf），",
          "任务描述中明确输出格式（JSON/表格），执行完成后向用户汇总结果。",
        ].join("\n"),
        async (reply) => {
          await transport.replyText(msg.messageId, reply || "子任务已发起。");
        },
      );
      return true;
    }

    return false;
  }

  /** 生成回复末尾的状态 footer：模型 + 上下文 + Token 明细（对应 /status） */
  private async buildReplyFooter(key: string): Promise<string> {
    try {
      const [model, ctx] = await Promise.all([
        this.conversations.getActualModel(key),
        this.conversations.getContextStatus(key),
      ]);
      return formatReplyFooter(model, ctx);
    } catch {
      return "";
    }
  }

  private isDuplicateContent(msg: FeishuMessage, key: string, text: string, attachments: Array<{ kind: string; fileKey: string; fileName?: string }>) {
    const now = Date.now();
    const attachmentKey = attachments.map((a) => `${a.kind}:${a.fileKey}:${a.fileName || ""}`).join("|");
    const contentKey = [key, msg.senderOpenId, normalizeForDedupe(text), attachmentKey].join("\u0000");
    const previousContentAt = this.recentContent.get(contentKey);
    if (previousContentAt && now - previousContentAt <= CONTENT_DEDUPE_TTL_MS) return true;
    this.recentContent.set(contentKey, now);
    if (this.recentContent.size > 2000) pruneRecentMap(this.recentContent, now, CONTENT_DEDUPE_TTL_MS);
    return false;
  }

  private async processAttachments(
    msg: FeishuMessage,
    attachments: Array<{ kind: "image" | "file"; fileKey: string; fileName?: string }>,
    modelSupportsImage: boolean,
  ) {
    const transport = this.getTransport();
    const imageInputs: FeishuImageInput[] = [];
    const fileSections: string[] = [];
    const downloadErrors: string[] = [];
    let skippedImageCount = 0;

    for (const attachment of attachments) {
      if (attachment.kind === "image") {
        if (!modelSupportsImage) {
          skippedImageCount += 1;
          continue;
        }
        if (!transport) {
          downloadErrors.push("飞书连接不可用，图片无法下载");
          continue;
        }
        try {
          const resource = await withTimeout(
            transport.downloadImage(msg.messageId, attachment.fileKey),
            15000,
            "图片下载超时",
          );
          const mimeType = detectImageMime(resource.bytes, resource.mimeType);
          if (!isSupportedImageMime(mimeType)) {
            downloadErrors.push("图片格式暂不支持（仅支持 png/jpg/webp）");
            continue;
          }
          imageInputs.push({
            type: "image",
            data: resource.bytes.toString("base64"),
            mimeType,
          });
        } catch (error) {
          debugLog("feishu.handler.image_error", {
            messageId: msg.messageId,
            fileKey: attachment.fileKey,
            error: error instanceof Error ? error.message : String(error),
          });
          downloadErrors.push(error instanceof Error ? error.message : "图片下载失败");
        }
        continue;
      }

      const fileName = attachment.fileName || "unnamed";
      if (!isSupportedTextFile(fileName)) {
        downloadErrors.push(`文件类型不支持：${fileName}`);
        continue;
      }
      if (!transport) {
        downloadErrors.push(`飞书连接不可用，文件无法下载：${fileName}`);
        continue;
      }
      try {
        const resource = await withTimeout(
          transport.downloadMessageResource(msg.messageId, attachment.fileKey, "file"),
          15000,
          `文件下载超时：${fileName}`,
        );
        const decoded = decodeTextFile(fileName, resource.bytes);
        if (!decoded.ok) {
          downloadErrors.push(`文件无法按文本读取：${fileName}`);
          continue;
        }
        const language = detectCodeLanguage(fileName);
        const suffix = decoded.truncated ? "\n[内容过长，已截断]" : "";
        fileSections.push(`[Feishu file: ${fileName}]\n\`\`\`${language}\n${decoded.text}${suffix}\n\`\`\``);
      } catch (error) {
        downloadErrors.push(error instanceof Error ? error.message : `文件下载失败：${fileName}`);
      }
    }

    return { imageInputs, fileSections, downloadErrors, skippedImageCount };
  }
}

function buildPrompt(
  msg: FeishuMessage,
  text: string,
  fileSections: string[],
  imageInputs: FeishuImageInput[],
  skippedImageCount: number,
  modelSupportsImage: boolean,
  downloadErrors: string[],
) {
  const contentParts: string[] = [];
  if (text.trim()) contentParts.push(text.trim());
  if (fileSections.length) contentParts.push(fileSections.join("\n\n"));
  if (!contentParts.length && imageInputs.length) {
    contentParts.push("请根据图片内容进行分析。");
  }

  if (skippedImageCount > 0 && !modelSupportsImage) {
    contentParts.push("[提示：当前模型不支持图片，本次仅处理文本/文件内容。]");
  }

  if (downloadErrors.length) {
    contentParts.push(`[部分附件未处理：${downloadErrors.join("；")}]`);
  }

  const promptBody = contentParts.join("\n\n").trim();
  const label = conversationLabel(msg);
  return label ? `${label} ${promptBody}` : promptBody;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
