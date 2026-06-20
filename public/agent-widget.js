(function initAvtomolAgentWidget() {
  if (window.AvtomolAgentWidgetLoaded) {
    return;
  }
  window.AvtomolAgentWidgetLoaded = true;

  function ready(callback) {
    if (document.body) {
      callback();
      return;
    }
    document.addEventListener("DOMContentLoaded", callback, { once: true });
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text) {
      node.textContent = text;
    }
    return node;
  }

  function parseQuickPrompts(value) {
    if (!value) {
      return [];
    }
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    } catch {
      return value
        .split("|")
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }

  function timeGreeting() {
    const hour = new Date().getHours();
    const hello = hour >= 18 || hour < 6 ? "Добър вечер!" : "Добър ден!";
    return `${hello} С какво мога да помогна? Опишете марка, модел, година и частта, която търсите.`;
  }

  function formatPrice(value, currency) {
    const price = Number(value);
    if (!Number.isFinite(price) || price <= 1) {
      return "цена при запитване";
    }
    try {
      return new Intl.NumberFormat("bg-BG", {
        currency: currency || "EUR",
        maximumFractionDigits: 2,
        style: "currency",
      }).format(price);
    } catch {
      return `${price} ${currency || ""}`.trim();
    }
  }

  function appendLinkedText(node, text) {
    const parts = String(text || "").split(/(https?:\/\/[^\s]+)/g);
    for (const part of parts) {
      if (!part) {
        continue;
      }
      if (/^https?:\/\//.test(part)) {
        const link = el("a", "ca-message-link", part);
        link.href = part;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        node.appendChild(link);
      } else {
        node.appendChild(document.createTextNode(part));
      }
    }
  }

  function renderBody(text) {
    const wrapper = el("div", "ca-message-body");
    let list = null;
    for (const rawLine of String(text || "").trim().split("\n")) {
      const line = rawLine.trim();
      if (!line) {
        list = null;
        continue;
      }
      if (line.startsWith("- ")) {
        if (!list) {
          list = el("ul", "ca-list");
          wrapper.appendChild(list);
        }
        const item = el("li", "");
        appendLinkedText(item, line.slice(2));
        list.appendChild(item);
        continue;
      }
      list = null;
      const paragraph = el("p", "");
      appendLinkedText(paragraph, line);
      wrapper.appendChild(paragraph);
    }
    return wrapper;
  }

  function randomId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function openUrl(url) {
    const target = String(url || "").trim();
    if (!target) {
      return;
    }
    try {
      window.top.location.href = target;
    } catch {
      window.location.href = target;
    }
  }

  const scriptTag =
    document.currentScript ||
    Array.from(document.querySelectorAll('script[src*="agent-widget.js"]')).pop() ||
    null;

  ready(function mount() {
    const dataset = (scriptTag && scriptTag.dataset) || {};
    const src = scriptTag && scriptTag.src ? new URL(scriptTag.src, window.location.href) : null;
    const apiBase = (dataset.apiBase || (src ? src.origin : window.location.origin)).replace(/\/$/, "");
    const config = {
      apiBase,
      autoOpenOnLoad: dataset.autoOpen !== "false",
      avatarUrl: dataset.avatarUrl || `${apiBase}/operator-avatar.png?v=avtomol-2`,
      greeting: dataset.greeting || timeGreeting(),
      linkColor: dataset.linkColor || "#c90018",
      primaryColor: dataset.primaryColor || "#c90018",
      quickPrompts: parseQuickPrompts(
        dataset.quickPrompts ||
          "Търся накладки за VW Golf 5 2006|Зимни гуми 205/55R16|Масло за BMW 320d 2008|Искам запитване по рама"
      ),
      subtitle: dataset.subtitle || "Авточасти, гуми, масла и акумулатори",
      title: dataset.title || "AvtoMol AI консултант",
      toggleLabel: dataset.toggleLabel || "Чат",
    };

    const host = el("div", "");
    host.id = "avtomol-agent-widget-root";
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });

    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        *, *::before, *::after { box-sizing: border-box; }
        .ca-root {
          position: fixed;
          right: 18px;
          bottom: 18px;
          z-index: 2147483000;
          font-family: "Segoe UI", Arial, sans-serif;
          color: #14202b;
        }
        .ca-panel {
          position: absolute;
          right: 0;
          bottom: 86px;
          width: min(410px, calc(100vw - 22px));
          height: min(650px, calc(100vh - 112px));
          display: none;
          flex-direction: column;
          overflow: hidden;
          border-radius: 18px;
          border: 1px solid rgba(10, 15, 20, 0.16);
          background: #fff;
          box-shadow: 0 26px 70px rgba(15, 23, 42, 0.28);
        }
        .ca-panel[data-open="true"] { display: flex; }
        .ca-header {
          padding: 16px;
          color: #fff;
          background: linear-gradient(135deg, var(--ca-primary), #151515);
        }
        .ca-header-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .ca-pill {
          padding: 6px 11px;
          border-radius: 999px;
          background: rgba(255,255,255,0.16);
          font-size: 12px;
          font-weight: 700;
        }
        .ca-actions { display: inline-flex; gap: 8px; }
        .ca-icon {
          width: 30px;
          height: 30px;
          border: 0;
          border-radius: 999px;
          background: transparent;
          color: inherit;
          cursor: pointer;
          font-size: 24px;
          line-height: 1;
        }
        .ca-icon:hover { background: rgba(255,255,255,0.14); }
        .ca-consultant {
          display: flex;
          align-items: center;
          gap: 13px;
          margin-top: 14px;
        }
        .ca-avatar {
          width: 64px;
          height: 64px;
          flex: 0 0 64px;
          overflow: hidden;
          border-radius: 999px;
          border: 2px solid rgba(255,255,255,0.45);
          background: rgba(255,255,255,0.12);
        }
        .ca-avatar img,
        .ca-toggle img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }
        .ca-fallback {
          width: 100%;
          height: 100%;
          display: grid;
          place-items: center;
          font-weight: 900;
          background: #1f2937;
          color: #fff;
        }
        .ca-consultant h3 {
          margin: 0 0 5px;
          font-size: 21px;
          line-height: 1.15;
        }
        .ca-consultant p {
          margin: 0;
          font-size: 13px;
          opacity: 0.92;
        }
        .ca-body {
          display: flex;
          min-height: 0;
          flex: 1;
          flex-direction: column;
          background:
            radial-gradient(circle at top left, rgba(201,0,24,0.07), transparent 42%),
            linear-gradient(180deg, #fff, #fff8f8);
        }
        .ca-messages {
          flex: 1;
          overflow-y: auto;
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .ca-bubble {
          max-width: 92%;
          padding: 12px 14px;
          border-radius: 16px;
          line-height: 1.5;
          font-size: 14px;
          word-break: break-word;
        }
        .ca-user {
          align-self: flex-end;
          background: color-mix(in srgb, var(--ca-primary) 12%, white);
        }
        .ca-assistant {
          align-self: flex-start;
          background: #fff;
          border: 1px solid rgba(15, 23, 42, 0.09);
        }
        .ca-loading { opacity: 0.7; font-style: italic; }
        .ca-message-body p { margin: 0 0 9px; }
        .ca-message-body p:last-child { margin-bottom: 0; }
        .ca-message-link {
          color: var(--ca-link);
          font-weight: 800;
          text-decoration: none;
        }
        .ca-list { margin: 0; padding-left: 18px; }
        .ca-suggestions {
          display: grid;
          gap: 8px;
          margin-top: 10px;
        }
        .ca-card {
          display: block;
          padding: 11px 12px;
          border-radius: 12px;
          text-decoration: none;
          color: inherit;
          background: #fffafa;
          border: 1px solid rgba(15, 23, 42, 0.1);
        }
        .ca-card strong { display: block; margin-bottom: 4px; font-size: 14px; }
        .ca-card span { display: block; line-height: 1.4; }
        .ca-card small {
          display: block;
          margin-top: 5px;
          color: rgba(15, 23, 42, 0.68);
        }
        .ca-primary-link {
          display: inline-flex;
          margin-top: 10px;
          min-height: 40px;
          align-items: center;
          justify-content: center;
          padding: 0 15px;
          border-radius: 999px;
          color: #fff;
          background: var(--ca-primary);
          text-decoration: none;
          font-weight: 800;
        }
        .ca-quick {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          padding: 0 16px 12px;
        }
        .ca-chip {
          border: 1px solid rgba(15, 23, 42, 0.12);
          border-radius: 999px;
          background: rgba(255,255,255,0.92);
          cursor: pointer;
          padding: 8px 10px;
          font: inherit;
          font-size: 12px;
        }
        .ca-form {
          display: flex;
          gap: 10px;
          padding: 12px 14px 14px;
          border-top: 1px solid rgba(15, 23, 42, 0.1);
          background: rgba(255,255,255,0.92);
        }
        .ca-input {
          flex: 1;
          min-width: 0;
          min-height: 48px;
          border: 1px solid rgba(15, 23, 42, 0.16);
          border-radius: 999px;
          padding: 0 15px;
          font: inherit;
          outline: none;
          background: #fff;
        }
        .ca-input:focus {
          border-color: var(--ca-primary);
          box-shadow: 0 0 0 4px color-mix(in srgb, var(--ca-primary) 14%, white);
        }
        .ca-send {
          min-width: 96px;
          border: 0;
          border-radius: 999px;
          color: #fff;
          background: var(--ca-primary);
          font: inherit;
          font-weight: 900;
          cursor: pointer;
        }
        .ca-toggle {
          width: 72px;
          height: 72px;
          border: 0;
          border-radius: 999px;
          overflow: hidden;
          cursor: pointer;
          background: #fff;
          box-shadow: 0 18px 44px rgba(15, 23, 42, 0.26);
        }
        @media (max-width: 560px) {
          .ca-root { right: 10px; bottom: 10px; }
          .ca-panel {
            width: min(100vw - 12px, 398px);
            height: min(84vh, 690px);
            bottom: 84px;
          }
          .ca-toggle { width: 66px; height: 66px; }
          .ca-send { min-width: 78px; }
        }
      </style>
      <div class="ca-root" style="--ca-primary:${config.primaryColor};--ca-link:${config.linkColor}">
        <div class="ca-panel" data-open="false">
          <div class="ca-header">
            <div class="ca-header-row">
              <span class="ca-pill">Онлайн авто консултант</span>
              <div class="ca-actions">
                <button class="ca-icon ca-minimize" type="button" aria-label="Минимизирай">−</button>
                <button class="ca-icon ca-close" type="button" aria-label="Затвори">×</button>
              </div>
            </div>
            <div class="ca-consultant">
              <div class="ca-avatar"></div>
              <div>
                <h3></h3>
                <p></p>
              </div>
            </div>
          </div>
          <div class="ca-body">
            <div class="ca-messages"></div>
            <div class="ca-quick"></div>
            <form class="ca-form">
              <input class="ca-input" type="text" placeholder="Напиши кола, година и част..." />
              <button class="ca-send" type="submit">Изпрати</button>
            </form>
          </div>
        </div>
        <button class="ca-toggle" type="button" aria-label="Отвори чат"></button>
      </div>
    `;

    const panel = shadow.querySelector(".ca-panel");
    const toggle = shadow.querySelector(".ca-toggle");
    const messages = shadow.querySelector(".ca-messages");
    const quick = shadow.querySelector(".ca-quick");
    const form = shadow.querySelector(".ca-form");
    const input = shadow.querySelector(".ca-input");
    const send = shadow.querySelector(".ca-send");
    const title = shadow.querySelector(".ca-consultant h3");
    const subtitle = shadow.querySelector(".ca-consultant p");
    const avatar = shadow.querySelector(".ca-avatar");
    const minimize = shadow.querySelector(".ca-minimize");
    const close = shadow.querySelector(".ca-close");

    const sessionKey = "avtomol-agent-session-id";
    const dismissedKey = "avtomol-agent-dismissed-auto-open";
    const state = {
      booted: false,
      opened: false,
      pending: false,
      sessionId: randomId(),
      dismissed: false,
    };

    try {
      state.sessionId = localStorage.getItem(sessionKey) || state.sessionId;
      localStorage.setItem(sessionKey, state.sessionId);
      state.dismissed = localStorage.getItem(dismissedKey) === "true";
    } catch {
      state.sessionId = state.sessionId;
    }

    function rememberDismissed() {
      state.dismissed = true;
      try {
        localStorage.setItem(dismissedKey, "true");
      } catch {
        state.dismissed = true;
      }
    }

    function addImage(container) {
      const image = el("img", "");
      image.src = config.avatarUrl;
      image.alt = config.title;
      image.loading = "lazy";
      image.addEventListener("error", function replaceImage() {
        image.replaceWith(el("div", "ca-fallback", "AI"));
      });
      container.appendChild(image);
    }

    title.textContent = config.title;
    subtitle.textContent = config.subtitle;
    addImage(avatar);
    addImage(toggle);

    function scrollBottom() {
      messages.scrollTop = messages.scrollHeight;
    }

    function appendMessage(role, text, suggestions, action) {
      const bubble = el("div", `ca-bubble ${role === "user" ? "ca-user" : "ca-assistant"}`);
      bubble.appendChild(renderBody(text));

      if (action && action.url) {
        const actionLink = el("a", "ca-primary-link", action.label || "Отвори");
        actionLink.href = action.url;
        actionLink.addEventListener("click", function navigate(event) {
          event.preventDefault();
          openUrl(action.url);
        });
        bubble.appendChild(actionLink);
      }

      if (Array.isArray(suggestions) && suggestions.length) {
        const list = el("div", "ca-suggestions");
        for (const suggestion of suggestions) {
          const card = el("a", "ca-card");
          card.href = suggestion.url || "#";
          card.addEventListener("click", function navigate(event) {
            event.preventDefault();
            openUrl(suggestion.url);
          });
          card.appendChild(el("strong", "", suggestion.name || "Продукт"));
          card.appendChild(el("span", "", suggestion.summary || suggestion.category || ""));
          card.appendChild(
            el(
              "small",
              "",
              `${formatPrice(suggestion.price, suggestion.currency)}${suggestion.matchReason ? ` • ${suggestion.matchReason}` : ""}`
            )
          );
          list.appendChild(card);
        }
        bubble.appendChild(list);
      }

      messages.appendChild(bubble);
      scrollBottom();
      return bubble;
    }

    function showGreeting() {
      if (state.booted) {
        return;
      }
      appendMessage("assistant", config.greeting);
      state.booted = true;
    }

    function setOpen(open) {
      state.opened = open;
      panel.dataset.open = open ? "true" : "false";
      if (open) {
        showGreeting();
        input.focus();
      }
    }

    async function sendMessage(value) {
      const message = String(value || "").trim();
      if (!message || state.pending) {
        return;
      }

      state.pending = true;
      appendMessage("user", message);
      input.value = "";
      input.disabled = true;
      send.disabled = true;

      const loading = el("div", "ca-bubble ca-assistant ca-loading", "Проверявам...");
      messages.appendChild(loading);
      scrollBottom();

      try {
        const response = await fetch(`${config.apiBase}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            currentUrl: window.location.href,
            message,
            pageTitle: document.title,
            sessionId: state.sessionId,
          }),
        });
        const payload = await response.json();
        loading.remove();
        if (!response.ok) {
          appendMessage("assistant", payload.error || "Не успях да отговоря в момента. Опитайте пак след малко.");
          return;
        }
        appendMessage("assistant", payload.reply, payload.suggestions || [], payload.focusAction || null);
      } catch {
        loading.remove();
        appendMessage("assistant", "В момента няма връзка с консултанта. Опитайте пак след малко.");
      } finally {
        state.pending = false;
        input.disabled = false;
        send.disabled = false;
        input.focus();
      }
    }

    form.addEventListener("submit", function submit(event) {
      event.preventDefault();
      sendMessage(input.value);
    });

    toggle.addEventListener("click", function togglePanel() {
      setOpen(!state.opened);
    });

    minimize.addEventListener("click", function minimizePanel() {
      rememberDismissed();
      setOpen(false);
    });

    close.addEventListener("click", function closePanel() {
      rememberDismissed();
      setOpen(false);
    });

    for (const prompt of config.quickPrompts) {
      const chip = el("button", "ca-chip", prompt);
      chip.type = "button";
      chip.addEventListener("click", function usePrompt() {
        setOpen(true);
        sendMessage(prompt);
      });
      quick.appendChild(chip);
    }

    if (config.autoOpenOnLoad && !state.dismissed) {
      window.setTimeout(function openOnce() {
        if (!state.dismissed) {
          setOpen(true);
        }
      }, 900);
    }
  });
})();
