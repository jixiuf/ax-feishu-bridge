/**
 * 外部协作桥（供 pi-hub 等扩展通过 globalThis 调用）：
 *
 * 目标：让 pi-hub 的协调消息 / subagent 回传 / 接管请求能作用于飞书会话，
 * 而不是只能注入 pi 主进程 TUI 会话（两者上下文割裂导致「回传看不到」）。
 *
 * 能力：
 *  - inject：向指定（或最近活跃）飞书会话注入外部消息，回复回显到飞书
 *  - acquire：抢占飞书 gateway（pi-hub 发起 feishu 接管时本机启动）
 *  - release：释放飞书 gateway（本机收到 feishu 接管请求时让位）
 *  - isActive / owner / activeKey / keys：查询能力
 *
 * 注册时机：gateway 启动成功（transport.isRunning）后注册，stop 时注销。
 * 版本化 key 消除加载顺序问题（与 pi-hub 的 __PI_HUB__ 同一模式）。
 */
import { debugLog } from "./debug.ts";
import type { GatewayOwner } from "./gateway-lock.ts";

export const EXTERNAL_BRIDGE_KEY = "__AX_FEISHU_BRIDGE__";

export type ExternalInjectResult = {
  ok: boolean;
  reply?: string;
  error?: string;
  key?: string;
};

export type ExternalFeishuBridge = {
  version: string;
  /** 是否持有 gateway（可收发飞书消息） */
  isActive(): boolean;
  /** 当前 gateway owner 信息（无则 undefined） */
  owner(): GatewayOwner | undefined;
  /** 最近活跃会话 key（p2p:xxx / group:xxx），无则 undefined */
  activeKey(): string | undefined;
  /** 全部已绑定会话 key */
  keys(): string[];
  /**
   * 向指定会话注入外部消息，回复回显到飞书。
   * key 传 "active" 或空串时自动选最近活跃会话。
   * 返回 { ok, reply, error }；ok=false 时调用方应回退其他通道。
   */
  inject(
    key: string,
    text: string,
    opts?: { echo?: boolean },
  ): Promise<ExternalInjectResult>;
  /** 抢占飞书 gateway（幂等：已持有则直接 ok）。等价 /feishu restart 的抢占语义。 */
  acquire(): Promise<{ ok: boolean; message?: string }>;
  /** 释放飞书 gateway（让位给接管方）。未持有则 no-op。 */
  release(): Promise<{ ok: boolean; message?: string }>;
  /** 当前是否有飞书触发的活跃 turn（供 ask-user-question-rpc 委托提问） */
  isFeishuTurnActive(): boolean;
  /** 当前活跃 turn 的目标用户 open_id（无则 null） */
  getActiveUserId(): string | null;
  /**
   * 通过飞书向用户提问（选项式），挂起等待回复。
   * 返回 null 表示超时 / 被取消 / 桥接不可用；cancel 映射为 kind="chat"。
   */
  askQuestion(opts: {
    userId?: string;
    key?: string;
    question: string;
    header?: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
    index?: number;
    total?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<
    | { kind: "option" | "custom" | "multi" | "chat"; answer: string | null; selected?: string[] }
    | null
  >;
};

/** 由 Pi / Harness 适配器在 gateway 就绪后调用注册。 */
export function registerExternalBridge(bridge: ExternalFeishuBridge): void {
  (globalThis as Record<string, unknown>)[EXTERNAL_BRIDGE_KEY] = bridge;
  debugLog("feishu.external_bridge_registered", { version: bridge.version });
}

export function unregisterExternalBridge(): void {
  delete (globalThis as Record<string, unknown>)[EXTERNAL_BRIDGE_KEY];
  debugLog("feishu.external_bridge_unregistered", {});
}

/** 供 pi-hub 等扩展读取；未注册（feishu 未激活）返回 undefined。 */
export function getExternalBridge(): ExternalFeishuBridge | undefined {
  return (globalThis as Record<string, unknown>)[EXTERNAL_BRIDGE_KEY] as
    | ExternalFeishuBridge
    | undefined;
}
