/* global window */
// The native preferences pane and the reader panel save the same connection.
(function () {
  "use strict";
  const prefix = "extensions.askgpt.";

  function saveConnection(prefs, { baseURL, model, apiKey, temperature }) {
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

  window.AskGPTSettings = { saveConnection };
})();
