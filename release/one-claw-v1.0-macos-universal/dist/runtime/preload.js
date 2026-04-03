// @bun
// runtime/preload.ts
var defaults = {
  VERSION: process.env.CLAUDE_CODE_VERSION ?? "1.0",
  PACKAGE_URL: process.env.CLAUDE_CODE_PACKAGE_URL ?? "@anthropic-ai/claude-code",
  NATIVE_PACKAGE_URL: process.env.CLAUDE_CODE_NATIVE_PACKAGE_URL ?? "@anthropic-ai/claude-code",
  BUILD_TIME: process.env.CLAUDE_CODE_BUILD_TIME ?? new Date().toISOString(),
  FEEDBACK_CHANNEL: process.env.CLAUDE_CODE_FEEDBACK_CHANNEL ?? "report issues on GitHub",
  ISSUES_EXPLAINER: process.env.CLAUDE_CODE_ISSUES_EXPLAINER ?? "open an issue at https://github.com/anthropics/claude-code/issues",
  VERSION_CHANGELOG: process.env.CLAUDE_CODE_VERSION_CHANGELOG ?? "https://github.com/anthropics/claude-code/releases"
};
var globalScope = globalThis;
globalScope.MACRO = {
  ...defaults,
  ...globalScope.MACRO
};
process.env.CLAUDE_CODE_SOURCE_RECONSTRUCTION ??= "1";
