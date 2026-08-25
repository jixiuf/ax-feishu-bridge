import test from "node:test";
import assert from "node:assert/strict";
import { appendReplyFooter, formatReplyFooter, formatTokenCount } from "../src/feishu/rich-text.ts";

test("appendReplyFooter appends footer after a blank line", () => {
  assert.equal(appendReplyFooter("你好", "上下文: 10%"), "你好\n\n上下文: 10%");
});

test("appendReplyFooter keeps multi-line body and appends footer at the end", () => {
  const body = "第一行\n第二行";
  assert.equal(appendReplyFooter(body, "模型: m1"), `${body}\n\n模型: m1`);
});

test("appendReplyFooter trims trailing whitespace before footer", () => {
  assert.equal(appendReplyFooter("回复内容  \n\n", "模型: m1"), `回复内容\n\n模型: m1`);
});

test("appendReplyFooter does not append when body is empty or footer is blank", () => {
  assert.equal(appendReplyFooter(""), "");
  assert.equal(appendReplyFooter("   \n "), "   \n ");
  assert.equal(appendReplyFooter("正文", ""), "正文");
  assert.equal(appendReplyFooter("正文", "   "), "正文");
});

test("formatTokenCount matches /status formatting", () => {
  assert.equal(formatTokenCount(512), "512");
  assert.equal(formatTokenCount(4_200), "4k");
  assert.equal(formatTokenCount(1_200_000), "1.2M");
});

test("formatReplyFooter renders model, context and token detail", () => {
  const footer = formatReplyFooter("openrouter/deepseek-v3", {
    tokens: 4_200,
    contextWindow: 128_000,
    percent: 3.3,
    totalInput: 100_000,
    totalOutput: 2_000,
    totalCacheRead: 80_000,
    totalCost: 0.0042,
    totalMessages: 12,
  });
  assert.equal(footer, "deepseek-v3 · 3.3% / 128k (↑4k tokens) · in 100k · out 2k · cache 80k · $0.0042");
});

test("formatReplyFooter strips provider prefix from model name", () => {
  assert.equal(formatReplyFooter("deepseek/deepseek-v4-flash", null), "deepseek-v4-flash · 暂无数据");
  assert.equal(formatReplyFooter("openrouter/deepseek-v3", { tokens: 1, contextWindow: 1000, percent: 0.1 }), "deepseek-v3 · 0.1% / 1k (↑1 tokens)");
  assert.equal(formatReplyFooter("local-model", null), "local-model · 暂无数据");
});

test("formatReplyFooter omits token detail when runtime does not provide it", () => {
  const footer = formatReplyFooter("openrouter/m1", { tokens: 1_000, contextWindow: 128_000, percent: 0.8 });
  assert.equal(footer, "m1 · 0.8% / 128k (↑1k tokens)");
});
