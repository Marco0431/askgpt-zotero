/* global window */
// The native preferences pane and the reader panel save the same connection.
(function () {
  "use strict";
  const prefix = "extensions.askgpt.";
  const fieldBindings = new WeakMap();

  // A loaded or retyped credential belongs to the origin shown at that time.
  function bindProviderKey(base, key) {
    let binding = fieldBindings.get(key);
    if (!binding) {
      const origin = () => window.AskGPTClient.providerOrigin(base.value);
      let boundOrigin;
      let boundValue;
      function capture() {
        boundOrigin = origin();
        boundValue = key.value;
      }
      function read() {
        const current = origin();
        if (!current) return "";
        if (current !== boundOrigin && key.value === boundValue) key.value = "";
        boundOrigin = current;
        boundValue = key.value;
        return key.value;
      }
      key.addEventListener("input", capture);
      base.addEventListener("change", read);
      binding = { capture, read };
      fieldBindings.set(key, binding);
    }
    binding.capture();
    return binding.read;
  }

  // Keep this snapshot in its owning form only. It includes a credential.
  function snapshot(prefs) {
    const get = (key) => prefs.get(prefix + key);
    return JSON.stringify([
      get("baseURL") || "https://api.deepseek.com",
      get("apiKey") || "",
      get("model") || "deepseek-chat",
      String(get("temperature") ?? 0.3),
      get("nativeSearch") === true,
      get("language") || "auto",
      get("systemPrompt") || "",
    ]);
  }

  function saveConnection(
    prefs,
    { baseURL, model, apiKey, temperature },
    expected,
  ) {
    if (expected !== snapshot(prefs)) {
      const error = new Error("Settings changed in another window.");
      error.name = "StaleAskGPTSettings";
      throw error;
    }
    const number = Number.parseFloat(temperature);
    const values = {
      baseURL,
      model,
      apiKey,
      temperature: String(
        Number.isFinite(number) ? Math.min(2, Math.max(0, number)) : 0.3,
      ),
    };
    const previous = new Map();
    try {
      for (const [field, value] of Object.entries(values)) {
        const key = prefix + field;
        const before = prefs.get(key);
        if (before === value) continue;
        previous.set(key, before);
        // Gecko supports integer and string preferences but no fractional type.
        if (field === "temperature" && typeof before === "number")
          prefs.clear(key);
        prefs.set(key, value);
      }
      // Older native UI bindings also wrote here. Never read a credential
      // from this separate branch into the active provider configuration.
      const key = prefix + "apiKey";
      if (prefs.get(key, true)) prefs.clear(key, true);
    } catch (error) {
      for (const [key, value] of Array.from(previous).reverse()) {
        const current = prefs.get(key);
        if (current === value) continue;
        if (current !== undefined && typeof current !== typeof value)
          prefs.clear(key);
        if (value !== undefined) prefs.set(key, value);
      }
      throw error;
    }
  }

  window.AskGPTSettings = { snapshot, saveConnection, bindProviderKey };
})();
