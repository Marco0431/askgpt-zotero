/* global window, URL, AbortController, TextDecoder, setTimeout, clearTimeout */
/* Provider-side Responses web search. No secondary search service is contacted. */
(function () {
  "use strict";
  const translations = {
    "zh-CN": {
      "native.modelRequired": "请先选择或填写模型名称。",
      "native.deepseekModel":
        "DeepSeek 官方接口的原生搜索目前需要 deepseek-v4-pro；请切换模型，或关闭联网搜索后使用普通对话。",
      "native.unsupported":
        "此接口或模型不接受 Responses 原生搜索请求。请检查服务商的搜索支持，或关闭联网搜索后重试。",
      "native.auth": "原生搜索认证失败，请检查 API Key 及其权限。",
      "native.quota":
        "原生搜索请求过于频繁或额度不足，请稍后重试并检查账户额度。",
      "native.http":
        "原生搜索请求失败（HTTP {status}），请检查接口配置或稍后重试。",
      "native.network":
        "无法连接原生搜索接口，请检查网络、地址和证书。接口重定向不会自动跟随。",
      "native.cancelled": "原生搜索已取消。",
      "native.timeout": "原生搜索请求超时，请稍后重试。",
      "native.protocol":
        "原生搜索返回了不兼容的数据，未确认回答完整。请检查 Responses API 支持。",
      "native.failed":
        "服务商报告原生搜索请求失败，未确认回答完整。请稍后重试或检查模型支持。",
      "native.incomplete":
        "原生搜索回答未完成，可能达到输出限制；请缩短问题或稍后重试。",
      "native.truncated":
        "原生搜索连接提前结束，未收到完整回答的确认。请重试。",
      "native.empty": "原生搜索请求已完成，但未返回可显示的回答。",
      "native.notSearched":
        "接口返回了回答，但未确认实际完成原生搜索；不能把此次测试视为搜索可用。",
      "native.inputRequired": "请先输入问题或添加图片。",
    },
    "en-US": {
      "native.modelRequired": "Select or enter a model ID first.",
      "native.deepseekModel":
        "Native search on the official DeepSeek API currently requires deepseek-v4-pro. Switch models, or turn off web search for regular chat.",
      "native.unsupported":
        "This endpoint or model does not accept Responses native search requests. Check the provider's search support, or turn off web search and try again.",
      "native.auth":
        "Native search authentication failed. Check your API key and its permissions.",
      "native.quota":
        "Native search was rate-limited or the account quota is insufficient. Check your quota and try again later.",
      "native.http":
        "Native search failed (HTTP {status}). Check the API settings or try again later.",
      "native.network":
        "Could not connect to native search. Check the network, address, and certificate. API redirects are not followed.",
      "native.cancelled": "Native search cancelled.",
      "native.timeout": "Native search timed out. Please try again later.",
      "native.protocol":
        "Native search returned incompatible data, so a complete answer could not be confirmed. Check Responses API support.",
      "native.failed":
        "The provider reported that native search failed. A complete answer could not be confirmed. Try again or check model support.",
      "native.incomplete":
        "The native search answer is incomplete, possibly due to an output limit. Shorten the question or try again later.",
      "native.truncated":
        "The native search connection ended before a complete answer was confirmed. Please try again.",
      "native.empty": "Native search completed without a displayable answer.",
      "native.notSearched":
        "The API answered, but did not confirm a completed native search. This test cannot verify search support.",
      "native.inputRequired": "Enter a question or add an image first.",
    },
  };
  window.AskGPTI18n?.register(translations);
  function t(key, vars = {}) {
    if (window.AskGPTI18n) return window.AskGPTI18n.t(key, vars);
    return translations["zh-CN"][key].replace(/\{(\w+)\}/g, (token, name) =>
      Object.prototype.hasOwnProperty.call(vars, name)
        ? String(vars[name])
        : token,
    );
  }
  function error(key, code = "native-search", vars) {
    const result = new Error(t(key, vars));
    result.code = code;
    result.nativeSearch = true;
    return result;
  }
  function clean(value) {
    // Header values and model IDs must not contain pasted invisible characters.
    return String(value || "").replace(
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u0020\u007f\u200b-\u200d\ufeff]/g,
      "",
    );
  }
  function validateConfig(config = {}) {
    const endpoint = window.AskGPTClient.buildEndpoint(
      config.baseURL,
      "responses",
    );
    const model = clean(config.model);
    if (!model) throw error("native.modelRequired", "configuration");
    if (
      new URL(endpoint).hostname.toLowerCase().replace(/\.$/, "") ===
        "api.deepseek.com" &&
      model !== "deepseek-v4-pro"
    ) {
      throw error("native.deepseekModel", "unsupported");
    }
  }

  function safeCitations(values) {
    const result = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
      if (
        !value ||
        (value.type && value.type !== "url_citation" && value.type !== "url")
      )
        continue;
      const source = value.url_citation || value;
      let url;
      try {
        url = new URL(source.url);
      } catch {
        continue;
      }
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        continue;
      const citation = {
        url: url.href,
        title:
          typeof source.title === "string" && source.title.trim()
            ? source.title.trim()
            : url.hostname,
      };
      const start = source.startIndex ?? source.start_index;
      const end = source.endIndex ?? source.end_index;
      if (
        Number.isSafeInteger(start) &&
        Number.isSafeInteger(end) &&
        start >= 0 &&
        end > start
      ) {
        citation.startIndex = start;
        citation.endIndex = end;
      }
      const identity = JSON.stringify([
        citation.url,
        citation.startIndex,
        citation.endIndex,
      ]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      result.push(citation);
    }
    // A source without offsets is redundant once inline occurrences are present.
    const inlineURLs = new Set(
      result.filter((c) => c.startIndex !== undefined).map((c) => c.url),
    );
    return result.filter(
      (c) => c.startIndex !== undefined || !inlineURLs.has(c.url),
    );
  }

  function inputMessages(messages) {
    const input = [];
    for (const message of Array.isArray(messages) ? messages : []) {
      if (
        !message ||
        !["system", "developer", "user", "assistant"].includes(message.role)
      )
        continue;
      const content = [];
      if (typeof message.content === "string" && message.content) {
        content.push({ type: "input_text", text: message.content });
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (
            ["text", "input_text", "output_text"].includes(part?.type) &&
            typeof part.text === "string"
          ) {
            content.push({ type: "input_text", text: part.text });
          } else if (
            message.role === "user" &&
            part?.type === "image_url" &&
            typeof part.image_url?.url === "string"
          ) {
            content.push({
              type: "input_image",
              image_url: part.image_url.url,
              detail: ["auto", "low", "high"].includes(part.image_url.detail)
                ? part.image_url.detail
                : "auto",
            });
          }
        }
      }
      if (!content.length) continue;
      // EasyInputMessage accepts prior assistant text as a string, without fake
      // output IDs, reasoning blocks, tool-call metadata, or citation metadata.
      input.push({
        role: message.role,
        content:
          message.role === "assistant"
            ? content.map((part) => part.text).join("\n")
            : content,
      });
    }
    return input;
  }

  function parser(options) {
    const parts = new Map();
    const itemIndices = new Map();
    const searches = new Map();
    const sources = [];
    const sequences = new Set();
    let emitted = "";
    let citationSnapshot = "";
    let completed = false;
    const orderedParts = () =>
      Array.from(parts.values()).sort(
        (a, b) =>
          a.outputIndex - b.outputIndex || a.contentIndex - b.contentIndex,
      );
    const text = () =>
      orderedParts()
        .map((part) => part.text)
        .join("");
    function partFor(event) {
      const itemId = event.item_id || event.id;
      const outputIndex = Number.isSafeInteger(event.output_index)
        ? event.output_index
        : (itemIndices.get(itemId) ?? 0);
      if (itemId) itemIndices.set(itemId, outputIndex);
      const contentIndex = Number.isSafeInteger(event.content_index)
        ? event.content_index
        : 0;
      const key = `${outputIndex}:${contentIndex}`;
      if (!parts.has(key))
        parts.set(key, {
          outputIndex,
          contentIndex,
          text: "",
          annotations: [],
        });
      return parts.get(key);
    }
    function citations() {
      let offset = 0;
      const combined = [...sources];
      for (const part of orderedParts()) {
        for (const citation of safeCitations(part.annotations)) {
          const mapped = { ...citation };
          if (
            mapped.startIndex !== undefined &&
            mapped.endIndex <= part.text.length
          ) {
            mapped.startIndex += offset;
            mapped.endIndex += offset;
          } else {
            delete mapped.startIndex;
            delete mapped.endIndex;
          }
          combined.push(mapped);
        }
        offset += part.text.length;
      }
      return safeCitations(combined);
    }
    function notify() {
      const current = text();
      if (current.startsWith(emitted) && current.length > emitted.length) {
        const delta = current.slice(emitted.length);
        emitted = current;
        options.onDelta?.(delta);
      }
      const references = citations();
      const signature = JSON.stringify(references);
      if (signature !== citationSnapshot) {
        citationSnapshot = signature;
        options.onAnnotations?.(references);
      }
    }
    function search(event, status) {
      const id =
        event.item_id || event.id || `index:${event.output_index ?? 0}`;
      const previous = searches.get(id);
      // Do not regress a completed call when a repeated earlier event arrives.
      if (previous === "completed" || previous === status) return;
      searches.set(id, status);
      options.onStatus?.({
        type: "search",
        status,
        searchCount: searches.size,
      });
    }
    function item(value, outputIndex, done) {
      if (!value || typeof value !== "object") return;
      if (value.id) itemIndices.set(value.id, outputIndex);
      if (value.type === "web_search_call") {
        if (value.status === "failed") throw error("native.failed", "provider");
        search(
          { id: value.id, output_index: outputIndex },
          ["completed", "searching"].includes(value.status)
            ? value.status
            : "in_progress",
        );
        if (Array.isArray(value.action?.sources))
          sources.push(...value.action.sources);
      } else if (value.type === "message" && value.role === "assistant") {
        if (value.status === "incomplete")
          throw error("native.incomplete", "incomplete");
        for (const [index, content] of (Array.isArray(value.content)
          ? value.content
          : []
        ).entries()) {
          const part = partFor({
            item_id: value.id,
            output_index: outputIndex,
            content_index: index,
          });
          if (content.type === "output_text") {
            if (done && typeof content.text === "string")
              part.text = content.text;
            if (Array.isArray(content.annotations))
              part.annotations.push(...content.annotations);
          } else if (
            content.type === "refusal" &&
            done &&
            typeof content.refusal === "string"
          ) {
            part.text = content.refusal;
          }
        }
      }
    }
    function event(value, eventName) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw error("native.protocol", "protocol");
      const type = value.type || eventName;
      if (Number.isSafeInteger(value.sequence_number)) {
        if (sequences.has(value.sequence_number)) return;
        sequences.add(value.sequence_number);
      }
      if (
        type === "error" ||
        type === "response.failed" ||
        type === "response.web_search_call.failed" ||
        type === "response.error"
      )
        throw error("native.failed", "provider");
      if (
        type === "response.incomplete" ||
        type === "response.cancelled" ||
        type === "response.web_search_call.incomplete"
      )
        throw error("native.incomplete", "incomplete");
      if (
        type === "response.output_text.delta" ||
        type === "response.refusal.delta"
      ) {
        if (typeof value.delta !== "string")
          throw error("native.protocol", "protocol");
        partFor(value).text += value.delta;
      } else if (
        type === "response.output_text.done" ||
        type === "response.refusal.done"
      ) {
        const finalText =
          type === "response.refusal.done" ? value.refusal : value.text;
        if (typeof finalText === "string") partFor(value).text = finalText;
      } else if (type === "response.output_text.annotation.added") {
        partFor(value).annotations.push(value.annotation);
      } else if (type === "response.content_part.done") {
        if (value.part?.type === "output_text") {
          const part = partFor(value);
          if (typeof value.part.text === "string") part.text = value.part.text;
          if (Array.isArray(value.part.annotations))
            part.annotations.push(...value.part.annotations);
        }
      } else if (
        /^response\.web_search_call\.(in_progress|searching|completed)$/.test(
          type,
        )
      ) {
        search(value, type.split(".").pop());
      } else if (
        type === "response.output_item.added" ||
        type === "response.output_item.done"
      ) {
        item(
          value.item,
          value.output_index ?? itemIndices.get(value.item?.id) ?? 0,
          type.endsWith(".done"),
        );
      } else if (type === "response.completed") {
        const response = value.response;
        if (
          !response ||
          (response.status && response.status !== "completed") ||
          response.error ||
          response.incomplete_details
        ) {
          throw error("native.incomplete", "incomplete");
        }
        for (const [index, output] of (Array.isArray(response.output)
          ? response.output
          : []
        ).entries())
          item(output, index, true);
        completed = true;
      }
      notify();
    }
    function finish() {
      if (!completed) throw error("native.truncated", "truncated");
      if (!text().trim()) throw error("native.empty", "empty");
      if (
        Array.from(searches.values()).some((status) => status !== "completed")
      )
        throw error("native.incomplete", "incomplete");
      if (
        options.forceSearch &&
        !Array.from(searches.values()).includes("completed")
      )
        throw error("native.notSearched", "not-searched");
      return {
        text: text(),
        citations: citations(),
        searched: searches.size > 0,
        searchCount: searches.size,
      };
    }
    return { event, finish, isComplete: () => completed };
  }

  async function stream(config = {}, options = {}) {
    const client = window.AskGPTClient;
    validateConfig(config);
    const endpoint = client.buildEndpoint(config.baseURL, "responses");
    const apiKey = clean(config.apiKey);
    const input = inputMessages(options.messages);
    if (!input.length) throw error("native.inputRequired", "configuration");
    const body = {
      model: clean(config.model),
      input,
      tools: [{ type: "web_search" }],
      tool_choice: options.forceSearch ? "required" : "auto",
      stream: true,
      store: false,
    };
    if (
      Number.isSafeInteger(options.maxOutputTokens) &&
      options.maxOutputTokens > 0
    )
      body.max_output_tokens = options.maxOutputTokens;
    const controller = new AbortController();
    let timedOut = false;
    let reader;
    let rejectAbort;
    const aborted = new Promise((_, reject) => {
      rejectAbort = reject;
    });
    const cancel = () => {
      controller.abort();
      const reason = error(
        timedOut ? "native.timeout" : "native.cancelled",
        timedOut ? "timeout" : "cancelled",
      );
      if (!timedOut) reason.name = "AbortError";
      rejectAbort(reason);
    };
    const externalAbort = () => cancel();
    const timeoutMs = Math.max(
      1,
      Math.min(600000, Number(options.timeoutMs ?? config.timeoutMs) || 120000),
    );
    const timer = setTimeout(() => {
      timedOut = true;
      cancel();
    }, timeoutMs);
    options.signal?.addEventListener("abort", externalAbort, { once: true });
    // Install a rejection handler before handling an already-aborted signal.
    const race = (promise) => Promise.race([promise, aborted]);
    aborted.catch(() => {});
    try {
      if (options.signal?.aborted) cancel();
      if (controller.signal.aborted) await aborted;
      const headers = {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      };
      if (apiKey) headers.Authorization = "Bearer " + apiKey;
      const fetchImpl = options.fetchImpl || window.fetch.bind(window);
      const response = await race(
        fetchImpl(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
          redirect: "error",
        }),
      );
      if (!response.ok) {
        const status = Number(response.status) || 0;
        const key = [400, 404, 405, 422, 501].includes(status)
          ? "native.unsupported"
          : [401, 403].includes(status)
            ? "native.auth"
            : status === 429
              ? "native.quota"
              : "native.http";
        const failure = error(
          key,
          key === "native.unsupported" ? "unsupported" : "http",
          { status },
        );
        failure.status = status;
        throw failure;
      }
      if (!response.body?.getReader) throw error("native.protocol", "protocol");
      reader = response.body.getReader();
      const state = parser(options);
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let buffer = "";
      let data = [];
      let eventName = "";
      function dispatch() {
        if (!data.length) {
          eventName = "";
          return;
        }
        const payload = data.join("\n");
        data = [];
        if (payload.trim() === "[DONE]") {
          if (!state.isComplete()) throw error("native.truncated", "truncated");
          eventName = "";
          return;
        }
        let value;
        try {
          value = JSON.parse(payload);
        } catch {
          throw error("native.protocol", "protocol");
        }
        state.event(value, eventName);
        eventName = "";
      }
      function line(value) {
        if (value.endsWith("\r")) value = value.slice(0, -1);
        if (!value) {
          dispatch();
          return;
        }
        if (value.startsWith(":")) return;
        const colon = value.indexOf(":");
        const field = colon < 0 ? value : value.slice(0, colon);
        let content = colon < 0 ? "" : value.slice(colon + 1);
        if (content.startsWith(" ")) content = content.slice(1);
        if (field === "data") data.push(content);
        else if (field === "event") eventName = content;
      }
      while (true) {
        const chunk = await race(reader.read());
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          line(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
        if (chunk.done) {
          if (buffer) line(buffer);
          dispatch();
          break;
        }
        if (state.isComplete()) break;
      }
      return state.finish();
    } catch (cause) {
      let failure = cause;
      if (timedOut) failure = error("native.timeout", "timeout");
      else if (controller.signal.aborted || options.signal?.aborted) {
        failure = error("native.cancelled", "cancelled");
        failure.name = "AbortError";
      } else if (!failure?.nativeSearch)
        failure = error("native.network", "network");
      // Never surface arbitrary server bodies or transport errors that may echo input.
      failure.message = client.safeErrorMessage(failure, apiKey);
      throw failure;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", externalAbort);
      if (reader) {
        try {
          Promise.resolve(reader.cancel()).catch(() => {});
        } catch {
          /* Best-effort cleanup. */
        }
        try {
          reader.releaseLock?.();
        } catch {
          /* A cancelled read may still be settling. */
        }
      }
    }
  }
  async function test(config, options = {}) {
    return stream(config, {
      signal: options.signal,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      forceSearch: true,
      maxOutputTokens: 4096,
      messages: [
        {
          role: "user",
          content:
            "Use web search to find the official Zotero website. Reply in one short sentence and cite its URL.",
        },
      ],
    });
  }
  window.AskGPTNativeSearch = { stream, test, validateConfig, safeCitations };
})();
