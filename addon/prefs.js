pref("baseURL", "https://api.deepseek.com");
pref("apiKey", "");
pref("model", "deepseek-chat");
pref("temperature", 0.3);
// Native search may incur provider tool charges; require explicit opt-in.
pref("nativeSearch", false);
pref("language", "auto");
// 整篇文献的来源：auto（用正在读的那个文件）/ pdf（PDF 优先）/ translation（译文优先）
pref("contextSource", "auto");
// 面板外观：字号（px，10~22）与面板尺寸（宽x高，px；默认宽而短）
pref("fontSize", 14);
pref("panelSize", "900x520");
pref("systemPrompt", "");
