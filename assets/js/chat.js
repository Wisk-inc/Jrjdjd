/* ==========================================================================
   CorX Chat — front-end shell.

   This file owns the interface only: the connect gate, extension detection,
   model picker, side dock, composer and thread rendering. It never talks to a
   model directly. All traffic goes through CorxChat.transport, which posts to
   the orchestrator endpoint; the orchestrator is what holds the OpenAI-
   compatible proxy from the "Sign in with ChatGPT" flow.

   Swap CorxChat.transport.send for your own implementation to wire a backend.
   ========================================================================== */
(function (window, document) {
  'use strict';

  var CorxChat = window.CorxChat = window.CorxChat || {};

  /* ---------------------------------------------------------------- config */
  var CONFIG = CorxChat.config = {
    // Endpoint the orchestrator listens on. Must be same-origin.
    endpoint: '/api/chat',
    // Handshake used to detect the "Sign in with ChatGPT" browser extension.
    // Adjust these to match whatever the installed extension actually exposes.
    extension: {
      globalKey: '__signInWithChatGPT',
      datasetFlag: 'siwcInstalled',
      pingType: 'siwc:ping',
      pongType: 'siwc:pong',
      timeoutMs: 900,
      installUrl: {
        chrome: 'https://chromewebstore.google.com/detail/sign-in-with-chatgpt/odbgboachaefbbbdiffcefhpkekhfcna',
        firefox: 'https://addons.mozilla.org/firefox/addon/sign-in-with-chatgpt/'
      }
    },
    storageKey: 'corx.chat.prefs'
  };

  /* ------------------------------------------------------------ small utils */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(CONFIG.storageKey)) || {}; }
    catch (e) { return {}; }
  }
  function savePrefs(patch) {
    try {
      var next = loadPrefs();
      Object.keys(patch).forEach(function (k) { next[k] = patch[k]; });
      localStorage.setItem(CONFIG.storageKey, JSON.stringify(next));
    } catch (e) { /* private mode — preferences just don't persist */ }
  }

  /* ------------------------------------------------- extension detection */
  CorxChat.detectExtension = function () {
    var cfg = CONFIG.extension;

    // 1. Synchronous markers, if the extension injects one.
    if (window[cfg.globalKey]) return Promise.resolve(true);
    if (document.documentElement.dataset[cfg.datasetFlag] === 'true') return Promise.resolve(true);

    // 2. postMessage handshake, resolving false on timeout.
    return new Promise(function (resolve) {
      var settled = false;
      function done(v) {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', onMessage);
        resolve(v);
      }
      function onMessage(e) {
        if (e.source !== window || !e.data) return;
        if (e.data.type === cfg.pongType) done(true);
      }
      window.addEventListener('message', onMessage);
      try { window.postMessage({ type: cfg.pingType, from: 'corx-chat' }, window.location.origin); }
      catch (err) { return done(false); }
      window.setTimeout(function () { done(false); }, cfg.timeoutMs);
    });
  };

  CorxChat.browserInstallUrl = function () {
    var ua = navigator.userAgent;
    if (/Firefox\//.test(ua)) return CONFIG.extension.installUrl.firefox;
    return CONFIG.extension.installUrl.chrome;
  };

  /* ------------------------------------------------------------- transport */
  CorxChat.transport = {
    /* Sends one turn to the orchestrator. Returns a promise for the reply.
       Replace this with a streaming implementation when the backend is live. */
    send: function (payload) {
      return fetch(CONFIG.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload)
      }).then(function (res) {
        if (!res.ok) throw new Error('Orchestrator responded ' + res.status);
        return res.json();
      });
    }
  };

  /* ------------------------------------------------------------------ boot */
  document.addEventListener('DOMContentLoaded', function () {
    var app = $('#chat-app');

    /* ---------- connect gate ---------- */
    var gate = $('#chat-gate');
    if (gate) {
      var stepExt = $('[data-step="extension"]', gate);
      var stepAuth = $('[data-step="auth"]', gate);
      var connectBtn = $('#chat-connect');
      var installBtn = $('#chat-install');
      var statusText = $('#gate-status');

      var setStep = function (li, state, label) {
        if (!li) return;
        li.setAttribute('data-state', state);
        var s = $('.status', li);
        if (s) s.textContent = label;
      };

      CorxChat.detectExtension().then(function (installed) {
        if (installed) {
          setStep(stepExt, 'done', 'Detected');
          if (installBtn) installBtn.hidden = true;
          if (connectBtn) connectBtn.hidden = false;
          if (statusText) statusText.textContent =
            'Extension detected. Continue to sign in with your ChatGPT account.';
        } else {
          setStep(stepExt, 'todo', 'Required');
          if (installBtn) {
            installBtn.hidden = false;
            installBtn.href = CorxChat.browserInstallUrl();
          }
          if (connectBtn) connectBtn.hidden = true;
          if (statusText) statusText.textContent =
            'The “Sign in with ChatGPT” extension was not detected. Install it, then reload this page.';
        }
        gate.setAttribute('data-extension', installed ? 'present' : 'missing');
      });

      if (connectBtn) {
        connectBtn.addEventListener('click', function () {
          setStep(stepAuth, 'pending', 'Waiting…');
          if (statusText) statusText.textContent = 'Authorising with your ChatGPT account…';
          window.postMessage({ type: 'siwc:authorize', from: 'corx-chat' }, window.location.origin);
        });
      }
    }

    if (!app) return;

    /* ---------- model picker ---------- */
    var picker = $('.model-picker', app);
    if (picker) {
      var mBtn = $('.model-btn', picker);
      var mMenu = $('.model-menu', picker);
      var mLabel = $('.model-name', mBtn);

      var prefs = loadPrefs();
      if (prefs.model) {
        $$('.model-opt', mMenu).forEach(function (o) {
          var on = o.getAttribute('data-model') === prefs.model;
          o.setAttribute('aria-selected', String(on));
          if (on && mLabel) mLabel.textContent = o.getAttribute('data-label') || prefs.model;
        });
      }

      mBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = !mMenu.hidden;
        mMenu.hidden = open;
        mBtn.setAttribute('aria-expanded', String(!open));
      });
      $$('.model-opt', mMenu).forEach(function (opt) {
        opt.addEventListener('click', function () {
          $$('.model-opt', mMenu).forEach(function (o) { o.setAttribute('aria-selected', 'false'); });
          opt.setAttribute('aria-selected', 'true');
          if (mLabel) mLabel.textContent = opt.getAttribute('data-label') || '';
          savePrefs({ model: opt.getAttribute('data-model') });
          mMenu.hidden = true;
          mBtn.setAttribute('aria-expanded', 'false');
        });
      });
      document.addEventListener('click', function () {
        if (!mMenu.hidden) { mMenu.hidden = true; mBtn.setAttribute('aria-expanded', 'false'); }
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !mMenu.hidden) {
          mMenu.hidden = true; mBtn.setAttribute('aria-expanded', 'false'); mBtn.focus();
        }
      });
    }

    /* ---------- side dock tabs ---------- */
    var tabs = $$('.dock-tab', app);
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        var target = tab.getAttribute('data-panel');
        tabs.forEach(function (t) { t.setAttribute('aria-selected', String(t === tab)); });
        $$('.dock-panel', app).forEach(function (p) {
          p.hidden = p.getAttribute('data-panel') !== target;
        });
      });
    });

    var dockToggle = $('#dock-toggle');
    if (dockToggle) {
      dockToggle.addEventListener('click', function () {
        var open = app.getAttribute('data-dock') !== 'closed';
        app.setAttribute('data-dock', open ? 'closed' : 'open');
        dockToggle.setAttribute('aria-pressed', String(!open));
      });
    }

    /* ---------- composer ---------- */
    var ta = $('#composer-input', app);
    if (ta) {
      var autosize = function () {
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 168) + 'px';
      };
      ta.addEventListener('input', autosize);
      autosize();

      ta.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
      });
    }

    var form = $('#composer-form', app);
    if (form) form.addEventListener('submit', function (e) { e.preventDefault(); submit(); });

    $$('.chip[data-toggle]', app).forEach(function (chip) {
      chip.addEventListener('click', function () {
        chip.setAttribute('aria-pressed', chip.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
      });
    });

    function submit() {
      if (!ta) return;
      var text = ta.value.trim();
      if (!text) return;

      appendMessage('user', text);
      ta.value = '';
      ta.style.height = 'auto';

      var pending = appendMessage('assistant', 'Connecting to the orchestrator…');

      CorxChat.transport.send({
        message: text,
        model: (loadPrefs().model || 'default'),
        tools: $$('.chip[data-toggle][aria-pressed="true"]', app).map(function (c) {
          return c.getAttribute('data-toggle');
        })
      }).then(function (reply) {
        setMessage(pending, reply && reply.text ? reply.text : '(empty response)');
      }).catch(function (err) {
        setMessage(pending,
          'No orchestrator is reachable at ' + CONFIG.endpoint + '. ' +
          'The interface is running, but the backend that holds your ChatGPT session ' +
          'is not connected yet. (' + err.message + ')');
      });
    }

    var threadInner = $('.chat-thread-inner', app);
    var thread = $('.chat-thread', app);

    // Open on the newest message, the way a chat app should.
    if (thread) {
      var jumpToLatest = function () { thread.scrollTop = thread.scrollHeight; };
      jumpToLatest();
      window.setTimeout(jumpToLatest, 120);
      window.addEventListener('load', jumpToLatest);
    }

    function appendMessage(role, text) {
      if (!threadInner) return null;
      var wrap = document.createElement('div');
      wrap.className = 'msg msg-' + role;
      var label = role === 'user' ? 'You' : 'CorX Chat';
      wrap.innerHTML =
        '<p class="msg-role">' + label + '</p>' +
        '<div class="msg-body"><p></p></div>';
      $('.msg-body p', wrap).textContent = text;
      threadInner.appendChild(wrap);
      if (thread) thread.scrollTop = thread.scrollHeight;
      return wrap;
    }
    function setMessage(node, text) {
      if (!node) return;
      $('.msg-body p', node).textContent = text;
      if (thread) thread.scrollTop = thread.scrollHeight;
    }

    /* ---------- new chat ---------- */
    var newBtn = $('.chat-new', app);
    if (newBtn && threadInner) {
      newBtn.addEventListener('click', function () {
        threadInner.innerHTML = '';
        appendMessage('assistant', 'New conversation. What are we building?');
        if (ta) ta.focus();
      });
    }
  });
})(window, document);
