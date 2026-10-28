export interface ReaderPanelState {
  visible: boolean;
  loading?: boolean;
  reader?: any;
}

interface ToolbarDependencies {
  toggle: (source: { reader: any; window: Window }) => Promise<void>;
  state: (window: Window) => ReaderPanelState;
  title: () => string;
  reportError: (error: unknown) => void;
}

interface ToolbarBinding {
  reader: any;
  document: Document;
  window: Window;
  button: HTMLButtonElement;
  dispose: () => void;
}

/** The reader chrome owns the toolbar; its PDF view iframe does not. */
export function readerHostWindow(reader: any, doc?: Document): Window | null {
  try {
    return (
      reader?._window ||
      reader?._iframe?.ownerGlobal ||
      (doc?.defaultView?.frameElement as any)?.ownerGlobal ||
      null
    );
  } catch {
    // Closed Gecko windows can leave dead wrappers during plugin shutdown.
    return null;
  }
}

/**
 * Zotero's renderToolbar supplies doc + synchronous append. Keep this controller
 * independent of the host singleton so lifecycle and activation can be tested.
 */
export function createReaderToolbar(dependencies: ToolbarDependencies) {
  const bindings = new Map<any, ToolbarBinding>();
  let disposed = false;

  function attach(event: {
    reader: any;
    doc?: Document;
    append?: (...nodes: Node[]) => void;
  }): HTMLButtonElement | null {
    if (disposed || !event.reader) return null;
    const reader = event.reader;
    const doc = event.doc || reader._iframeWindow?.document;
    const host = readerHostWindow(reader, doc);
    if (!doc || !host || host.closed) return null;
    // Fallback is only for readers whose toolbar was mounted before registration.
    const target = !event.append
      ? doc.querySelector(".toolbar .end .custom-sections") ||
        doc.querySelector(".toolbar .end") ||
        doc.querySelector(".toolbar")
      : null;
    if (!event.append && !target) return null;

    let binding = bindings.get(reader);
    if (binding && (binding.document !== doc || binding.window !== host)) {
      binding.dispose();
      binding = undefined;
    }
    if (!binding) {
      // Remove the old fixed-position entry when upgrading without a restart.
      for (const view of [
        reader._internalReader?._primaryView?._iframeWindow,
        reader._internalReader?._secondaryView?._iframeWindow,
      ]) {
        if (view?.document && view.document !== doc)
          view.document.getElementById("askgpt-toolbar-button")?.remove();
      }
      doc.getElementById("askgpt-toolbar-button")?.remove();
      const button = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "button",
      ) as HTMLButtonElement;
      button.id = "askgpt-toolbar-button";
      button.type = "button";
      button.className = "toolbar-button askgpt-toolbar-button";
      button.textContent = "AskGPT";
      button.title = dependencies.title();
      // Reader FocusManager navigates toolbar items with tabindex=-1 by arrows.
      button.tabIndex = -1;
      button.setAttribute("aria-label", "AskGPT");
      button.setAttribute("aria-expanded", "false");
      button.style.cssText =
        "width:auto;min-width:64px;padding-inline:8px;flex:none;" +
        "font-size:12px;font-weight:600;line-height:1.2;white-space:nowrap;";
      let pending = false;
      let removed = false;
      let state: ReaderPanelState = dependencies.state(host);
      const update = () => {
        if (removed) return;
        const active = state.visible && state.reader === reader;
        const loading = pending || (active && !!state.loading);
        button.disabled = loading;
        button.setAttribute("aria-busy", String(loading));
        button.setAttribute("aria-expanded", String(active));
        button.classList.toggle("active", active);
      };
      const onState = (event: Event) => {
        state = (event as CustomEvent<ReaderPanelState>).detail;
        update();
      };
      const onClick = async (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        if (pending || button.disabled || removed) return;
        pending = true;
        update();
        try {
          await dependencies.toggle({ reader, window: host });
        } catch (error) {
          dependencies.reportError(error);
        } finally {
          pending = false;
          if (!removed) {
            state = dependencies.state(host);
            update();
          }
        }
      };
      // Native button activation emits click for Enter/Space. Only suppress held
      // keys; adding another keydown activation would toggle the panel twice.
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.repeat && ["Enter", " "].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
        }
      };
      const dispose = () => {
        if (removed) return;
        removed = true;
        button.removeEventListener("click", onClick);
        button.removeEventListener("keydown", onKeyDown);
        host.document.removeEventListener("askgpt-panel-state", onState);
        doc.defaultView?.removeEventListener("pagehide", dispose);
        host.removeEventListener("unload", dispose);
        button.remove();
        bindings.delete(reader);
      };
      button.addEventListener("click", onClick);
      button.addEventListener("keydown", onKeyDown);
      host.document.addEventListener("askgpt-panel-state", onState);
      doc.defaultView?.addEventListener("pagehide", dispose);
      host.addEventListener("unload", dispose);
      binding = { reader, document: doc, window: host, button, dispose };
      bindings.set(reader, binding);
      update();
    }
    try {
      // Must happen synchronously during the official renderToolbar callback.
      if (event.append) event.append(binding.button);
      else if (!binding.button.isConnected) target!.appendChild(binding.button);
    } catch (error) {
      binding.dispose();
      dependencies.reportError(error);
      return null;
    }
    return binding.button;
  }

  function remove(window?: Window) {
    for (const binding of Array.from(bindings.values())) {
      if (!window || binding.window === window) binding.dispose();
    }
  }
  return {
    attach,
    remove,
    destroy() {
      disposed = true;
      remove();
    },
  };
}
