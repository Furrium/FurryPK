// 修复 CLIENT_ID / CLIENT_SECRET 未定义的问题
// 病因：oauth-nodeloc.js 第 18/22 行使用裸标识符（应为 process.env.*）
// 方式：在 index.js 之前预加载，注入到 globalThis，供裸标识符读取
// 不影响源码，未配置时优雅禁用 OAuth 而非崩溃
'use strict';
globalThis.CLIENT_ID = process.env.NODELOC_CLIENT_ID || process.env.CLIENT_ID || '';
globalThis.CLIENT_SECRET = process.env.NODELOC_CLIENT_SECRET || process.env.CLIENT_SECRET || '';
