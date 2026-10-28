/* global window, URL, AbortController, FileReader, atob, setTimeout, clearTimeout */
(function () {
  "use strict";

  const IMAGE_LIMITS = Object.freeze({
    maxCount: 4,
    maxFileBytes: 8 * 1024 * 1024,
    maxTotalBytes: 20 * 1024 * 1024,
  });
  const imageTypes = ["image/png", "image/jpeg", "image/webp"];

  const translations = {
    "zh-CN": {
      "client.addressRequired": "请先填写接口地址。",
      "client.addressProtocol": "接口地址必须使用 http 或 https。",
      "client.addressInvalid": "接口地址无效，请检查完整网址。",
      "client.addressUnsafe":
        "接口地址不能包含账号密码、查询参数或锚点；请把 API Key 填在单独的输入框。",
      "client.endpointUnknown": "未知的接口类型。",
      "client.failed": "请求失败",
      "client.keyHidden": "[API Key 已隐藏]",
      "client.hidden": "[已隐藏]",
      "client.imageHidden": "[图片数据已隐藏]",
      "client.http400": "请求参数不被接口接受，请检查模型名称及接口兼容性。",
      "client.http401": "认证失败，请检查 API Key。",
      "client.http403": "没有访问权限，请检查 API Key 的权限和可用模型。",
      "client.http404": "找不到接口或模型，请检查接口地址和模型名称。",
      "client.http413": "请求内容过大，请减少图片数量或大小。",
      "client.http429": "请求过于频繁或额度不足，请稍后重试并检查账户额度。",
      "client.httpServer": "服务暂时不可用，请稍后重试。",
      "client.httpOther": "请求失败，请检查接口配置。",
      "client.http": "HTTP {status}：{hint}",
      "client.cancelled": "请求已取消。",
      "client.jsonInvalid":
        "接口没有返回有效的 JSON，请检查是否填入了 API 地址而非网站首页。",
      "client.timeout": "请求超时，请检查网络或接口地址后重试。",
      "client.network":
        "无法连接接口，请检查网络、接口地址和证书。接口重定向不会自动跟随。",
      "client.modelsInvalid": "模型列表格式不兼容；你仍可以手动填写模型名称。",
      "client.modelsEmpty": "接口未返回可用模型；你仍可以手动填写模型名称。",
      "client.modelRequired": "请先选择或填写模型名称。",
      "client.replyEmpty":
        "接口已响应，但模型没有返回文本；请检查模型是否支持 Chat Completions，或稍后再试。",
      "client.imageCount": "每条消息最多添加 4 张图片。",
      "client.imageEmpty": "图片文件为空或无法读取。",
      "client.imageSize": "每张图片不能超过 8 MB。",
      "client.imageType": "只支持 PNG、JPEG 和 WebP 图片。",
      "client.imageTotal": "每条消息的图片总大小不能超过 20 MB。",
      "client.imageRead": "无法读取图片，请重新选择文件。",
      "client.imageCancelled": "图片读取已取消。",
      "client.imageInvalid":
        "图片内容与格式不符，请选择有效的 PNG、JPEG 或 WebP 文件。",
      "client.imageName": "图片",
    },
    "en-US": {
      "client.addressRequired": "Enter an API address first.",
      "client.addressProtocol": "The API address must use http or https.",
      "client.addressInvalid": "Invalid API address. Check the complete URL.",
      "client.addressUnsafe":
        "The API address cannot include credentials, query parameters, or a fragment. Enter the API key in its own field.",
      "client.endpointUnknown": "Unknown API endpoint type.",
      "client.failed": "Request failed",
      "client.keyHidden": "[API key hidden]",
      "client.hidden": "[hidden]",
      "client.imageHidden": "[image data hidden]",
      "client.http400":
        "The API rejected the request. Check the model ID and API compatibility.",
      "client.http401": "Authentication failed. Check your API key.",
      "client.http403":
        "Access denied. Check your API key permissions and available models.",
      "client.http404":
        "API endpoint or model not found. Check the API address and model ID.",
      "client.http413":
        "The request is too large. Use fewer or smaller images.",
      "client.http429":
        "Rate limit or quota exceeded. Check your account quota and try again later.",
      "client.httpServer":
        "The service is temporarily unavailable. Try again later.",
      "client.httpOther": "Request failed. Check your API configuration.",
      "client.http": "HTTP {status}: {hint}",
      "client.cancelled": "Request cancelled.",
      "client.jsonInvalid":
        "The API did not return valid JSON. Make sure the address points to an API, not a website homepage.",
      "client.timeout":
        "Request timed out. Check your network and API address, then try again.",
      "client.network":
        "Could not connect. Check your network, API address, and certificate. API redirects are not followed automatically.",
      "client.modelsInvalid":
        "Unsupported model-list format. You can still enter a model ID manually.",
      "client.modelsEmpty":
        "The API returned no available models. You can still enter a model ID manually.",
      "client.modelRequired": "Select or enter a model ID first.",
      "client.replyEmpty":
        "The API responded, but the model returned no text. Check whether the model supports Chat Completions, or try again later.",
      "client.imageCount": "You can attach up to 4 images per message.",
      "client.imageEmpty": "The image file is empty or unreadable.",
      "client.imageSize": "Each image must be 8 MB or smaller.",
      "client.imageType": "Only PNG, JPEG, and WebP images are supported.",
      "client.imageTotal": "Images in one message must total 20 MB or less.",
      "client.imageRead": "Could not read the image. Select the file again.",
      "client.imageCancelled": "Image loading cancelled.",
      "client.imageInvalid":
        "The image content does not match its format. Select a valid PNG, JPEG, or WebP file.",
      "client.imageName": "Image",
    },
  };
  if (window.AskGPTI18n) window.AskGPTI18n.register(translations);
  function t(key, vars = {}) {
    if (window.AskGPTI18n) return window.AskGPTI18n.t(key, vars);
    return translations["zh-CN"][key].replace(/\{(\w+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(vars, name)
        ? String(vars[name])
        : match,
    );
  }

  function clean(value) {
    return (
      String(value == null ? "" : value)
        // Strip pasted header/URL control characters deliberately.
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0020\u007f\u200b-\u200d\ufeff]/g, "")
        .trim()
    );
  }

  function clientError(message, code, status) {
    const error = new Error(message);
    error.code = code;
    if (status) error.status = status;
    return error;
  }

  function buildEndpoint(base, kind = "chat") {
    let address = clean(base);
    if (!address)
      throw clientError(t("client.addressRequired"), "configuration");
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(address)) {
      // A host with an explicit port is still an address without a scheme.
      if (
        /^[a-z][a-z0-9+.-]*:/i.test(address) &&
        !/^[\w.-]+:\d+(?:\/|$)/.test(address)
      ) {
        throw clientError(t("client.addressProtocol"), "configuration");
      }
      address = "https://" + address;
    }
    let url;
    try {
      url = new URL(address);
    } catch {
      throw clientError(t("client.addressInvalid"), "configuration");
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      throw clientError(t("client.addressProtocol"), "configuration");
    }
    if (url.username || url.password || url.search || url.hash) {
      throw clientError(t("client.addressUnsafe"), "configuration");
    }
    if (!["chat", "models", "responses"].includes(kind)) {
      throw clientError(t("client.endpointUnknown"), "configuration");
    }
    let path = url.pathname.replace(/\/+$/, "");
    const completeEndpoint = /\/(?:chat\/completions|models|responses)$/.test(
      path,
    );
    path = path.replace(/\/(?:chat\/completions|models|responses)$/, "");
    // DeepSeek documents its native Responses endpoint at the root.
    if (
      !path &&
      !completeEndpoint &&
      !(kind === "responses" && url.hostname === "api.deepseek.com")
    )
      path = "/v1";
    const suffix = {
      chat: "/chat/completions",
      models: "/models",
      responses: "/responses",
    }[kind];
    url.pathname = path + suffix;
    return url.toString();
  }

  function safeErrorMessage(error, apiKey = "") {
    let message = String(
      error && error.message ? error.message : error || t("client.failed"),
    );
    const keys = [String(apiKey || ""), clean(apiKey)].filter(Boolean);
    for (const key of keys) {
      message = message.split(key).join(t("client.keyHidden"));
      try {
        message = message
          .split(encodeURIComponent(key))
          .join(t("client.keyHidden"));
      } catch {
        // Malformed pasted Unicode must not break error reporting.
      }
    }
    return (
      message
        .replace(/Bearer\s+[^\s,;"'<>]+/gi, "Bearer " + t("client.hidden"))
        .replace(/sk-[a-z0-9_-]+/gi, t("client.keyHidden"))
        .replace(
          /data:image\/[^;,\s]+;base64,[a-z0-9+/=]+/gi,
          t("client.imageHidden"),
        )
        .replace(
          /(["']?(?:api[_-]?key|access_token|authorization)["']?\s*[:=]\s*["']?)[^\s,;&"'<>]+/gi,
          "$1" + t("client.hidden"),
        )
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .slice(0, 320)
    );
  }

  function httpError(status, data) {
    const hintKey = [400, 401, 403, 404, 413, 429].includes(status)
      ? "client.http" + status
      : status >= 500
        ? "client.httpServer"
        : "client.httpOther";
    const error = clientError(
      t("client.http", { status, hint: t(hintKey) }),
      "http",
      status,
    );
    // Keep only the capability signal, never the provider's raw error body.
    const detail = data && data.error;
    const message = String((detail && detail.message) || "");
    error.unsupportedMaxTokens =
      status === 400 &&
      ((/max_tokens/i.test(message) &&
        /unsupported|not supported|not allowed|unexpected|not permitted/i.test(
          message,
        )) ||
        (detail &&
          detail.param === "max_tokens" &&
          detail.code === "unsupported_parameter"));
    return error;
  }

  async function requestJSON(config, kind, body, options = {}) {
    const endpoint = buildEndpoint(config.baseURL, kind);
    const key = clean(config.apiKey);
    const fetchImpl = options.fetchImpl || window.fetch.bind(window);
    const timeoutMs =
      Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : 15000;
    const controller = new AbortController();
    let timedOut = false;
    let rejectAbort;
    const aborted = new Promise((_, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () =>
      rejectAbort(clientError(t("client.cancelled"), "aborted"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const abortFromCaller = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else
        options.signal.addEventListener("abort", abortFromCaller, {
          once: true,
        });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const headers = { Accept: "application/json" };
    if (key) headers.Authorization = "Bearer " + key;
    if (body) headers["Content-Type"] = "application/json";
    try {
      if (controller.signal.aborted) return await aborted;
      const request = async () => {
        const response = await fetchImpl(endpoint, {
          method: body ? "POST" : "GET",
          headers,
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal,
          redirect: "error",
        });
        let data;
        try {
          data = await response.json();
        } catch {
          if (!response.ok) throw httpError(response.status);
          throw clientError(t("client.jsonInvalid"), "response");
        }
        if (!response.ok) throw httpError(response.status, data);
        return data;
      };
      return await Promise.race([request(), aborted]);
    } catch (error) {
      if (timedOut) throw clientError(t("client.timeout"), "timeout");
      if (controller.signal.aborted)
        throw clientError(t("client.cancelled"), "aborted");
      if (error && ["http", "response"].includes(error.code)) throw error;
      throw clientError(t("client.network"), "network");
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      if (options.signal)
        options.signal.removeEventListener("abort", abortFromCaller);
    }
  }

  async function fetchModels(config, options) {
    const result = await requestJSON(config, "models", null, options);
    if (!result || !Array.isArray(result.data)) {
      throw clientError(t("client.modelsInvalid"), "response");
    }
    const models = new Map();
    for (const model of result.data) {
      if (!model || typeof model.id !== "string" || !model.id.trim()) continue;
      const id = model.id.trim();
      const modalities = model.input_modalities || model.inputModalities;
      const entry = { id };
      if (Array.isArray(modalities)) {
        entry.inputModalities = [
          ...new Set(modalities.filter((value) => typeof value === "string")),
        ];
      }
      if (!models.has(id) || entry.inputModalities) models.set(id, entry);
    }
    if (!models.size) throw clientError(t("client.modelsEmpty"), "response");
    return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async function testConnection(config, options) {
    const model = clean(config.model);
    if (!model) throw clientError(t("client.modelRequired"), "configuration");
    const started = Date.now();
    const body = {
      model,
      messages: [{ role: "user", content: "Reply with OK." }],
      stream: false,
      max_tokens: 32,
    };
    let result;
    try {
      result = await requestJSON(config, "chat", body, options);
    } catch (error) {
      if (!error.unsupportedMaxTokens) throw error;
      delete body.max_tokens;
      body.max_completion_tokens = 32;
      result = await requestJSON(config, "chat", body, options);
    }
    const message =
      result &&
      result.choices &&
      result.choices[0] &&
      result.choices[0].message;
    const content = message && message.content;
    const hasContent =
      typeof content === "string"
        ? !!content.trim()
        : Array.isArray(content) &&
          content.some(
            (part) => part && typeof part.text === "string" && part.text.trim(),
          );
    if (!message || message.role !== "assistant" || !hasContent) {
      throw clientError(t("client.replyEmpty"), "response");
    }
    return { model, elapsedMs: Date.now() - started };
  }

  function validateImageBatch(files, existing = []) {
    const additions = Array.from(files || []);
    const current = Array.from(existing || []);
    if (additions.length + current.length > IMAGE_LIMITS.maxCount) {
      throw clientError(t("client.imageCount"), "image");
    }
    let total = 0;
    for (const file of [...current, ...additions]) {
      if (!file || !Number.isFinite(file.size) || file.size <= 0) {
        throw clientError(t("client.imageEmpty"), "image");
      }
      if (file.size > IMAGE_LIMITS.maxFileBytes) {
        throw clientError(t("client.imageSize"), "image");
      }
      if (file.type && !imageTypes.includes(file.type.toLowerCase())) {
        throw clientError(t("client.imageType"), "image");
      }
      total += file.size;
    }
    if (total > IMAGE_LIMITS.maxTotalBytes) {
      throw clientError(t("client.imageTotal"), "image");
    }
    return true;
  }

  async function readImage(file) {
    validateImageBatch([file]);
    const url = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () =>
        reject(clientError(t("client.imageRead"), "image"));
      reader.onabort = () =>
        reject(clientError(t("client.imageCancelled"), "image"));
      reader.readAsDataURL(file);
    });
    const encoded = url.slice(url.indexOf(",") + 1);
    const header = atob(encoded.slice(0, 24));
    let type;
    if (header.startsWith("\x89PNG\r\n\x1a\n")) type = "image/png";
    else if (header.startsWith("\xff\xd8\xff")) type = "image/jpeg";
    else if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP")
      type = "image/webp";
    if (!type || (file.type && file.type.toLowerCase() !== type)) {
      throw clientError(t("client.imageInvalid"), "image");
    }
    return {
      name: String(file.name || t("client.imageName")).slice(0, 200),
      type,
      size: file.size,
      url: `data:${type};base64,${encoded}`,
    };
  }

  window.AskGPTClient = Object.freeze({
    buildEndpoint,
    fetchModels,
    testConnection,
    safeErrorMessage,
    formatError: safeErrorMessage,
    validateImageBatch,
    readImage,
    IMAGE_LIMITS,
  });
})();
