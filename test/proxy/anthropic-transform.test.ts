import { describe, expect, test } from "bun:test";
import {
  anthropicToOpenAI,
  anthropicToolsToOpenAI,
  anthropicToolChoiceToOpenAI,
} from "../../src/proxy/transforms/anthropic";

describe("anthropic tool conversion", () => {
  test("converts {name, description, input_schema} to OpenAI function shape", () => {
    const out = anthropicToolsToOpenAI([
      {
        name: "get_weather",
        description: "get weather",
        input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    ]);
    expect(out).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "get weather",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      },
    ]);
  });

  test("passes through already-OpenAI-shaped tools unchanged", () => {
    const openai = [{ type: "function", function: { name: "f", parameters: { type: "object", properties: {} } } }];
    expect(anthropicToolsToOpenAI(openai)).toEqual(openai);
  });

  test("drops tools without a name and defaults missing schema", () => {
    const out = anthropicToolsToOpenAI([{ description: "no name" }, { name: "ok" }]);
    expect(out).toEqual([
      { type: "function", function: { name: "ok", description: "", parameters: { type: "object", properties: {} } } },
    ]);
  });

  test("returns undefined for empty/absent tools", () => {
    expect(anthropicToolsToOpenAI(undefined)).toBeUndefined();
    expect(anthropicToolsToOpenAI([])).toBeUndefined();
  });
});

describe("anthropic tool_choice conversion", () => {
  test("maps object forms to OpenAI equivalents", () => {
    expect(anthropicToolChoiceToOpenAI({ type: "auto" })).toBe("auto");
    expect(anthropicToolChoiceToOpenAI({ type: "any" })).toBe("required");
    expect(anthropicToolChoiceToOpenAI({ type: "none" })).toBe("none");
    expect(anthropicToolChoiceToOpenAI({ type: "tool", name: "f" })).toEqual({
      type: "function",
      function: { name: "f" },
    });
  });

  test("passes string forms through and ignores null", () => {
    expect(anthropicToolChoiceToOpenAI("auto")).toBe("auto");
    expect(anthropicToolChoiceToOpenAI(null)).toBeUndefined();
  });
});

describe("anthropicToOpenAI request mapping", () => {
  test("produces OpenAI-shaped tools in the converted request", () => {
    const req = anthropicToOpenAI({
      model: "qd-Qwen3.7-Max",
      max_tokens: 64,
      messages: [{ role: "user", content: "weather in Tokyo?" }],
      tools: [{ name: "get_weather", description: "w", input_schema: { type: "object", properties: {} } }],
      tool_choice: { type: "any" },
    });
    expect(req.tools?.[0]).toEqual({
      type: "function",
      function: { name: "get_weather", description: "w", parameters: { type: "object", properties: {} } },
    });
    expect(req.tool_choice).toBe("required");
  });

  test("omits tools/tool_choice keys when not provided", () => {
    const req = anthropicToOpenAI({
      model: "kp-opus-4.6-thinking",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    });
    expect("tools" in req).toBe(false);
    expect("tool_choice" in req).toBe(false);
  });

  test("prepends system prompt as a system message", () => {
    const req = anthropicToOpenAI({
      model: "kp-opus-4.6-thinking",
      max_tokens: 64,
      system: "be terse",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(req.messages[0]).toEqual({ role: "system", content: "be terse" });
  });
});
