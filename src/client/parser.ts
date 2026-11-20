import type { StepResult } from "../types/client";

export interface FormMarkers {
  hasUser: boolean;
  hasPass: boolean;
  hasRoom: boolean;
  hasCmd1: boolean;
  hasCmd2: boolean;
  hasCmd3: boolean;
}

/**
 * HTML本文から ReturnCode=... のカンマ区切り数値配列を抽出する。
 */
export function parseReturnCode(body: string): {
  raw: string | null;
  values: number[] | null;
} {
  const match = body.match(/ReturnCode=([^\r\n<]*)/);
  const raw = match?.[1]?.trim() ?? "";
  if (!raw) {
    return { raw: null, values: null };
  }

  const tokens = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

  if (tokens.length === 0) {
    return { raw, values: null };
  }

  const values = tokens.map(Number);
  if (values.some(Number.isNaN)) {
    return { raw, values: null };
  }

  return { raw, values };
}

/**
 * レスポンスに含まれるフォーム入力マーカーを検査する。
 */
export function inspectFormMarkers(body: string): FormMarkers {
  return {
    hasUser: body.includes("user="),
    hasPass: body.includes("pass="),
    hasRoom: body.includes("roomNumber="),
    hasCmd1: body.includes("command1="),
    hasCmd2: body.includes("command2="),
    hasCmd3: body.includes("command3="),
  };
}

/**
 * HTMLタグを取り除き、空行を除いた可視テキスト行一覧を返す。
 */
export function extractVisibleLines(body: string): string[] {
  const withoutBlocks = body
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<(?:br|\/p|\/div|\/tr|\/li|\/h[1-6]|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(?:td|th)>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"');

  return withoutBlocks
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);
}

/**
 * HTTPレスポンス本文を解析済みの StepResult に組み立てる。
 */
export function buildStepResult(body: string): StepResult {
  const parsed = parseReturnCode(body);
  return {
    body,
    values: parsed.values,
    rawReturnCode: parsed.raw,
    textLines: extractVisibleLines(body),
  };
}
