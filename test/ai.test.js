import test from "node:test";
import assert from "node:assert/strict";

process.env.SOCIAL_AUTOPOST = "false";

const { AI_ROUTING, engineOrder } = await import("../src/services/ai.js");

test("Groq stays on fast JSON while Gemini owns grounding and articles", () => {
  assert.deepEqual(AI_ROUTING, {
    json: "groq",
    grounding: "gemini",
    articles: "gemini",
    chat: "groq",
  });
});

test("engine order honors an explicit preference and defaults to Groq", () => {
  assert.deepEqual(engineOrder(), ["groq", "gemini"]);
  assert.deepEqual(engineOrder("groq"), ["groq", "gemini"]);
  assert.deepEqual(engineOrder("gemini"), ["gemini", "groq"]);
  assert.deepEqual(engineOrder("unknown"), ["groq", "gemini"]);
});
