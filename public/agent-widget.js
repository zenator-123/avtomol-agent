(function initAvtomolAgentWidget() {
  if (window.AvtomolAgentWidgetLoaded) {
    return;
  }
  window.AvtomolAgentWidgetLoaded = true;

  function onReady(callback) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", callback, { once: true });
      return;
    }
    callback();
  }

  function text(value) {
    return String(value || "").trim();
  }

  function createId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return "session-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  function parsePrompts(value) {
    if (!value) {
      return [
        "Търся накладки за VW Golf 5 2006",
        "Зимни гуми 205/55R16",
        "Масло за BMW 320d 2008",
        "Искам запитване по рама"
      ];
    }

    try {
      var parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    } catch (error) {
      return value
        .split("|")
        .map(function (item) {
          return item.trim();
        })
        .filter(Boolean);
    }
  }

  function timeGreeting() {
    var hour = new Date().getHours();
    var greeting = hour >= 18 || hour < 6 ? "Добър вечер!" : "Добър ден!";
    return (
      greeting +
      " С какво мога да помогна? Опишете марка, модел, година и частта, която търсите."
    );
  }

  function formatPrice(value, currency) {
    var price = Number(value);
    if (!Number.isFinite(price) || price <= 1) {
      return "цена при запитване";
    }

    try {
      return new Intl.NumberFormat("bg-BG", {
        currency: currency || "EUR",
        maximumFractionDigits: 2,
        style: "currency"
      }).format(price);
    } catch (error) {
      return (price + " " + (currency || "")).trim();
    }
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function linkify(value) {
    return escapeHtml(value).replace(/(https?:\/\/[^\s<]+)/g, function (url) {
      return (
        '<a class="avm-agent-link" target="_blank" rel="noopener noreferrer" href="' +
        url +
        '">' +
        url +
        "</a>"
      );
    });
  }

  function renderMessageText(value) {
    var lines = String(value || "").trim().split("\n");
    var html = "";
    var inList = false;

    lines.forEach(function (rawLine) {
      var line = rawLine.trim();
      if (!line) {
        if (inList) {
          html += "</ul>";
          inList = false;
        }
        return;
      }

      if (line.indexOf("- ") === 0) {
        if (!inList) {
          html += '<ul class="avm-agent-list">';
          inList = true;
        }
        html += "<li>" + linkify(line.slice(2)) + "</li>";
        return;
      }

      if (inList) {
        html += "</ul>";
        inList = false;
      }
      html += "<p>" + linkify(line) + "</p>";
    });

    if (inList) {
      html += "</ul>";
    }

    return html || "<p></p>";
  }

  function buildSuggestionHtml(suggestions) {
    if (!Array.isArray(suggestions) || !suggestions.length) {
      return "";
    }

    return (
      '<div class="avm-agent-suggestions">' +
      suggestions
        .map(function (suggestion) {
          var url = escapeHtml(suggestion.url || "#");
          var name = escapeHtml(suggestion.name || "Продукт");
          var summary = escapeHtml(suggestion.summary || suggestion.category || "");
          var price = escapeHtml(formatPrice(suggestion.price, suggestion.currency));
          var reason = suggestion.matchReason ? " • " + escapeHtml(suggestion.matchReason) : "";
          return (
            '<a class="avm-agent-card" href="' +
            url +
            '" target="_blank" rel="noopener noreferrer">' +
            "<strong>" +
            name +
            "</strong><span>" +
            summary +
            "</span><small>" +
            price +
            reason +
            "</small></a>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function getScriptTag() {
    return (
      document.currentScript ||
      Array.prototype.slice.call(document.querySelectorAll('script[src*="agent-widget.js"]')).pop()
    );
  }

  var scriptTag = getScriptTag();

  onReady(function mountAvtomolAgent() {
    try {
      var dataset = (scriptTag && scriptTag.dataset) || {};
      var sourceUrl = scriptTag && scriptTag.src ? new URL(scriptTag.src, window.location.href) : null;
      var apiBase = (dataset.apiBase || (sourceUrl ? sourceUrl.origin : window.location.origin)).replace(
        /\/$/,
        ""
      );
      var config = {
        apiBase: apiBase,
        autoOpen: dataset.autoOpen !== "false",
        avatarUrl: dataset.avatarUrl || apiBase + "/operator-avatar.png?v=avtomol-3",
        greeting: dataset.greeting || timeGreeting(),
        primaryColor: dataset.primaryColor || "#c90018",
        subtitle: dataset.subtitle || "Авточасти, гуми, масла и акумулатори",
        title: dataset.title || "AvtoMol AI консултант",
        toggleLabel: dataset.toggleLabel || "Чат",
        quickPrompts: parsePrompts(dataset.quickPrompts)
      };

      var root = document.getElementById("avtomol-agent-widget-root");
      if (!root) {
        root = document.createElement("div");
        root.id = "avtomol-agent-widget-root";
        document.body.appendChild(root);
      }

      root.innerHTML =
        '<style id="avm-agent-style">' +
        "#avtomol-agent-widget-root{all:initial;position:relative;z-index:2147483000}" +
        "#avtomol-agent-widget-root *{box-sizing:border-box}" +
        ".avm-agent-root{position:fixed;right:18px;bottom:18px;z-index:2147483000;font-family:Arial,'Segoe UI',sans-serif;color:#14202b}" +
        ".avm-agent-panel{position:absolute;right:0;bottom:86px;width:min(410px,calc(100vw - 22px));height:min(650px,calc(100vh - 112px));display:none;flex-direction:column;overflow:hidden;border-radius:18px;border:1px solid rgba(10,15,20,.16);background:#fff;box-shadow:0 26px 70px rgba(15,23,42,.28)}" +
        '.avm-agent-panel[data-open="true"]{display:flex}' +
        ".avm-agent-header{padding:16px;color:#fff;background:linear-gradient(135deg,var(--avm-primary),#151515)}" +
        ".avm-agent-top{display:flex;align-items:center;justify-content:space-between;gap:12px}" +
        ".avm-agent-pill{padding:6px 11px;border-radius:999px;background:rgba(255,255,255,.16);font-size:12px;font-weight:700}" +
        ".avm-agent-actions{display:inline-flex;gap:8px}" +
        ".avm-agent-icon{width:30px;height:30px;border:0;border-radius:999px;background:transparent;color:inherit;cursor:pointer;font-size:24px;line-height:1}" +
        ".avm-agent-icon:hover{background:rgba(255,255,255,.14)}" +
        ".avm-agent-person{display:flex;align-items:center;gap:13px;margin-top:14px}" +
        ".avm-agent-avatar,.avm-agent-toggle{overflow:hidden;border-radius:999px;background:#fff}" +
        ".avm-agent-avatar{width:64px;height:64px;flex:0 0 64px;border:2px solid rgba(255,255,255,.45)}" +
        ".avm-agent-avatar img,.avm-agent-toggle img{width:100%;height:100%;object-fit:cover;display:block}" +
        ".avm-agent-fallback{width:100%;height:100%;display:grid;place-items:center;font-weight:900;background:#1f2937;color:#fff}" +
        ".avm-agent-person h3{margin:0 0 5px;font-size:21px;line-height:1.15;color:#fff}" +
        ".avm-agent-person p{margin:0;font-size:13px;opacity:.92;color:#fff}" +
        ".avm-agent-body{display:flex;min-height:0;flex:1;flex-direction:column;background:radial-gradient(circle at top left,rgba(201,0,24,.07),transparent 42%),linear-gradient(180deg,#fff,#fff8f8)}" +
        ".avm-agent-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}" +
        ".avm-agent-bubble{max-width:92%;padding:12px 14px;border-radius:16px;line-height:1.5;font-size:14px;word-break:break-word}" +
        ".avm-agent-user{align-self:flex-end;background:#ffe8eb}" +
        ".avm-agent-assistant{align-self:flex-start;background:#fff;border:1px solid rgba(15,23,42,.09)}" +
        ".avm-agent-loading{opacity:.72;font-style:italic}" +
        ".avm-agent-bubble p{margin:0 0 9px}.avm-agent-bubble p:last-child{margin-bottom:0}" +
        ".avm-agent-link{color:var(--avm-primary);font-weight:800;text-decoration:none}" +
        ".avm-agent-list{margin:0;padding-left:18px}" +
        ".avm-agent-suggestions{display:grid;gap:8px;margin-top:10px}" +
        ".avm-agent-card{display:block;padding:11px 12px;border-radius:12px;text-decoration:none;color:inherit;background:#fffafa;border:1px solid rgba(15,23,42,.1)}" +
        ".avm-agent-card strong{display:block;margin-bottom:4px;font-size:14px}.avm-agent-card span{display:block;line-height:1.4}.avm-agent-card small{display:block;margin-top:5px;color:rgba(15,23,42,.68)}" +
        ".avm-agent-quick{display:flex;flex-wrap:wrap;gap:8px;padding:0 16px 12px}" +
        ".avm-agent-chip{border:1px solid rgba(15,23,42,.12);border-radius:999px;background:rgba(255,255,255,.92);cursor:pointer;padding:8px 10px;font:inherit;font-size:12px;color:#14202b}" +
        ".avm-agent-form{display:flex;gap:10px;padding:12px 14px 14px;border-top:1px solid rgba(15,23,42,.1);background:rgba(255,255,255,.92)}" +
        ".avm-agent-input{flex:1;min-width:0;min-height:48px;border:1px solid rgba(15,23,42,.16);border-radius:999px;padding:0 15px;font:inherit;outline:none;background:#fff;color:#14202b}" +
        ".avm-agent-input:focus{border-color:var(--avm-primary);box-shadow:0 0 0 4px rgba(201,0,24,.12)}" +
        ".avm-agent-send{min-width:96px;border:0;border-radius:999px;color:#fff;background:var(--avm-primary);font:inherit;font-weight:900;cursor:pointer}" +
        ".avm-agent-toggle{width:72px;height:72px;border:0;cursor:pointer;box-shadow:0 18px 44px rgba(15,23,42,.26)}" +
        ".avm-agent-toggle-fallback{width:100%;height:100%;display:grid;place-items:center;background:#c90018;color:#fff;font-weight:900}" +
        "@media(max-width:560px){.avm-agent-root{right:10px;bottom:10px}.avm-agent-panel{width:min(100vw - 12px,398px);height:min(84vh,690px);bottom:84px}.avm-agent-toggle{width:66px;height:66px}.avm-agent-send{min-width:78px}}" +
        "</style>" +
        '<div class="avm-agent-root" style="--avm-primary:' +
        escapeHtml(config.primaryColor) +
        '">' +
        '<div class="avm-agent-panel" data-open="false">' +
        '<div class="avm-agent-header"><div class="avm-agent-top">' +
        '<span class="avm-agent-pill">Онлайн авто консултант</span>' +
        '<div class="avm-agent-actions"><button class="avm-agent-icon avm-agent-min" type="button" aria-label="Минимизирай">-</button><button class="avm-agent-icon avm-agent-close" type="button" aria-label="Затвори">×</button></div>' +
        '</div><div class="avm-agent-person"><div class="avm-agent-avatar"></div><div><h3>' +
        escapeHtml(config.title) +
        "</h3><p>" +
        escapeHtml(config.subtitle) +
        "</p></div></div></div>" +
        '<div class="avm-agent-body"><div class="avm-agent-messages"></div><div class="avm-agent-quick"></div>' +
        '<form class="avm-agent-form"><input class="avm-agent-input" type="text" placeholder="Напиши кола, година и част..." /><button class="avm-agent-send" type="submit">Изпрати</button></form>' +
        "</div></div>" +
        '<button class="avm-agent-toggle" type="button" aria-label="' +
        escapeHtml(config.toggleLabel) +
        '"></button></div>';

      var panel = root.querySelector(".avm-agent-panel");
      var toggle = root.querySelector(".avm-agent-toggle");
      var avatar = root.querySelector(".avm-agent-avatar");
      var messages = root.querySelector(".avm-agent-messages");
      var quick = root.querySelector(".avm-agent-quick");
      var form = root.querySelector(".avm-agent-form");
      var input = root.querySelector(".avm-agent-input");
      var send = root.querySelector(".avm-agent-send");
      var minimize = root.querySelector(".avm-agent-min");
      var close = root.querySelector(".avm-agent-close");

      var sessionKey = "avtomol-agent-session-id";
      var dismissedKey = "avtomol-agent-dismissed-auto-open-v3";
      var state = {
        booted: false,
        opened: false,
        pending: false,
        sessionId: createId(),
        dismissed: false
      };

      try {
        state.sessionId = localStorage.getItem(sessionKey) || state.sessionId;
        localStorage.setItem(sessionKey, state.sessionId);
        state.dismissed = localStorage.getItem(dismissedKey) === "true";
      } catch (error) {
        state.dismissed = false;
      }

      function addImage(container) {
        var image = document.createElement("img");
        image.src = config.avatarUrl;
        image.alt = config.title;
        image.loading = "lazy";
        image.onerror = function () {
          container.innerHTML = '<div class="avm-agent-fallback">AI</div>';
        };
        container.appendChild(image);
      }

      addImage(avatar);
      addImage(toggle);

      function rememberDismissed() {
        state.dismissed = true;
        try {
          localStorage.setItem(dismissedKey, "true");
        } catch (error) {
          state.dismissed = true;
        }
      }

      function scrollBottom() {
        messages.scrollTop = messages.scrollHeight;
      }

      function appendMessage(role, body, suggestions) {
        var bubble = document.createElement("div");
        bubble.className =
          "avm-agent-bubble " + (role === "user" ? "avm-agent-user" : "avm-agent-assistant");
        bubble.innerHTML = renderMessageText(body) + buildSuggestionHtml(suggestions);
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
        panel.setAttribute("data-open", open ? "true" : "false");
        if (open) {
          showGreeting();
          window.setTimeout(function () {
            input.focus();
          }, 40);
        }
      }

      async function sendMessage(value) {
        var message = text(value);
        if (!message || state.pending) {
          return;
        }

        state.pending = true;
        appendMessage("user", message);
        input.value = "";
        input.disabled = true;
        send.disabled = true;
        var loading = appendMessage("assistant", "Проверявам...");
        loading.classList.add("avm-agent-loading");

        try {
          var response = await fetch(config.apiBase + "/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              currentUrl: window.location.href,
              message: message,
              pageTitle: document.title,
              sessionId: state.sessionId
            })
          });
          var payload = await response.json();
          loading.remove();

          if (!response.ok) {
            appendMessage(
              "assistant",
              payload.error || "Не успях да отговоря в момента. Опитайте пак след малко."
            );
            return;
          }

          appendMessage("assistant", payload.reply, payload.suggestions || []);
        } catch (error) {
          loading.remove();
          appendMessage(
            "assistant",
            "В момента няма връзка с консултанта. Опитайте пак след малко."
          );
        } finally {
          state.pending = false;
          input.disabled = false;
          send.disabled = false;
          input.focus();
        }
      }

      form.addEventListener("submit", function (event) {
        event.preventDefault();
        sendMessage(input.value);
      });

      toggle.addEventListener("click", function () {
        setOpen(!state.opened);
      });

      minimize.addEventListener("click", function () {
        rememberDismissed();
        setOpen(false);
      });

      close.addEventListener("click", function () {
        rememberDismissed();
        setOpen(false);
      });

      config.quickPrompts.forEach(function (prompt) {
        var chip = document.createElement("button");
        chip.type = "button";
        chip.className = "avm-agent-chip";
        chip.textContent = prompt;
        chip.addEventListener("click", function () {
          setOpen(true);
          sendMessage(prompt);
        });
        quick.appendChild(chip);
      });

      if (config.autoOpen && !state.dismissed) {
        window.setTimeout(function () {
          if (!state.dismissed) {
            setOpen(true);
          }
        }, 900);
      }
    } catch (error) {
      console.error("AvtoMol AI widget failed to mount:", error);
    }
  });
})();
