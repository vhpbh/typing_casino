/*
 * taskpane.js
 * Core logic for the Typing Casino Word add-in.
 *
 * KNOWN PLATFORM LIMITATIONS (read before relying on this in production):
 *  1. Office.js cannot read Word's native spell-check flags, and cannot see
 *     raw keystroke or paste events inside the document editing surface.
 *     Both "is this word correctly spelled" and "was this typed or pasted"
 *     are therefore approximated:
 *       - Spelling: checked against bundled offline dictionaries (see
 *         spellcheck.js) instead of Word's own proofing engine.
 *       - Typed vs. pasted: a short-interval polling loop diffs the
 *         document's text. A large chunk of new text appearing between two
 *         polls (many words at once) is treated as a paste and excluded.
 *         A human typing normally only ever adds a word or two between
 *         polls, so this is a reliable heuristic in practice but not a
 *         mathematical guarantee.
 *  2. If text is edited in the *middle* of the document (not appended at
 *     the end), this build simply re-syncs its baseline on the next poll
 *     without counting or penalizing anything from that edit. Extending
 *     this to fully track mid-document edits is possible but out of scope
 *     for this build.
 */
(function () {
  "use strict";

  var POLL_MS = 300;
  var PASTE_CHAR_THRESHOLD = 25;
  var PASTE_MIN_TOKENS = 3;
  var SYNC_EVERY_MS = 3000;

  var state = {
    lastText: "",
    pendingBuffer: "",
    lettersCount: 0,
    wordsCount: 0,
    skippedMisspelled: 0,
    skippedPasted: 0,
    lastSyncAt: 0,
    sb: null, // supabase client
    userId: null,
  };

  var el = {};

  function cacheEls() {
    el.letterCount = document.getElementById("letter-count");
    el.wordsCount = document.getElementById("words-count");
    el.skippedMisspelled = document.getElementById("skipped-misspelled");
    el.skippedPasted = document.getElementById("skipped-pasted");
    el.connBadge = document.getElementById("conn-badge");
    el.setupPanel = document.getElementById("setup-panel");
    el.btnOpenSetup = document.getElementById("btn-open-setup");
    el.btnSaveSetup = document.getElementById("btn-save-setup");
    el.inputUrl = document.getElementById("input-url");
    el.inputKey = document.getElementById("input-key");
    el.adSlot = document.getElementById("ad-slot");
    el.adImage = document.getElementById("ad-image");
    el.adLink = document.getElementById("ad-link");
  }

  function render() {
    el.letterCount.textContent = state.lettersCount.toLocaleString();
    el.wordsCount.textContent = state.wordsCount.toLocaleString();
    el.skippedMisspelled.textContent = state.skippedMisspelled.toLocaleString();
    el.skippedPasted.textContent = state.skippedPasted.toLocaleString();
  }

  function setConnBadge(connected) {
    el.connBadge.textContent = window.I18N.t(connected ? "conn-on" : "conn-off");
    el.connBadge.className = "badge " + (connected ? "badge-on" : "badge-off");
  }

  // ---- Word.js: read the whole document body as plain text ----
  function readDocumentText() {
    return Word.run(function (context) {
      var body = context.document.body;
      body.load("text");
      return context.sync().then(function () {
        return body.text;
      });
    });
  }

  // Strip leading/trailing punctuation from a token, keep inner letters
  // (handles Hebrew niqqud/geresh and Latin apostrophes reasonably).
  function cleanToken(token) {
    return token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
  }

  function tokenize(text) {
    return text.split(/\s+/).filter(Boolean);
  }

  function processSegment(segment, isPaste) {
    state.pendingBuffer += segment;

    // Split into tokens; the LAST token might still be mid-typing (no
    // trailing whitespace yet), so keep it in the buffer for next time -
    // UNLESS the buffer itself ends in whitespace, meaning every token in
    // it is actually complete.
    var endsWithBoundary = /\s$/.test(state.pendingBuffer);
    var tokens = tokenize(state.pendingBuffer);

    var completed = endsWithBoundary ? tokens : tokens.slice(0, -1);
    state.pendingBuffer = endsWithBoundary ? "" : (tokens.length ? tokens[tokens.length - 1] : "");

    completed.forEach(function (raw) {
      var word = cleanToken(raw);
      if (!word) return; // pure punctuation/number token, ignore silently

      if (isPaste) {
        state.skippedPasted++;
        return;
      }

      if (window.Spellcheck.isValidCompleteWord(word)) {
        state.wordsCount++;
        state.lettersCount += word.length;
      } else {
        state.skippedMisspelled++;
      }
    });
  }

  function diffAndProcess(currentText) {
    var last = state.lastText;

    if (currentText === last) return;

    if (currentText.indexOf(last) === 0) {
      // Simple, common case: pure append (typing or pasting at the end).
      var segment = currentText.slice(last.length);
      var segTokens = tokenize(segment);
      var looksLikePaste =
        segment.length > PASTE_CHAR_THRESHOLD && segTokens.length >= 2 ||
        segTokens.length >= PASTE_MIN_TOKENS;
      processSegment(segment, looksLikePaste);
    } else {
      // Edit happened somewhere other than the very end (mid-document edit
      // or a deletion). We don't try to reconstruct exactly what changed;
      // just resync the baseline. See file header note #2.
    }

    state.lastText = currentText;
  }

  function pollLoop() {
    if (!window.Spellcheck.isReady()) {
      setTimeout(pollLoop, POLL_MS);
      return;
    }
    readDocumentText()
      .then(function (text) {
        diffAndProcess(text);
        render();
        maybeSync();
      })
      .catch(function (err) {
        console.error("Typing Casino: failed to read document text", err);
      })
      .finally(function () {
        setTimeout(pollLoop, POLL_MS);
      });
  }

  // ---- Supabase: identity, progress sync, ad slot ----
  function loadSupabaseSettings() {
    return new Promise(function (resolve) {
      Office.context.roamingSettings.get
        ? resolve({
            url: Office.context.roamingSettings.get("sb_url"),
            key: Office.context.roamingSettings.get("sb_key"),
          })
        : resolve({ url: null, key: null });
    });
  }

  function saveSupabaseSettings(url, key) {
    Office.context.roamingSettings.set("sb_url", url);
    Office.context.roamingSettings.set("sb_key", key);
    Office.context.roamingSettings.saveAsync();
  }

  function initSupabase(url, key) {
    if (!url || !key) {
      setConnBadge(false);
      return Promise.resolve();
    }
    state.sb = window.supabase.createClient(url, key);
    return state.sb.auth
      .signInAnonymously()
      .then(function (res) {
        if (res.error) throw res.error;
        state.userId = res.data.user.id;
        setConnBadge(true);
        loadAd();
      })
      .catch(function (err) {
        console.error("Typing Casino: Supabase connection failed", err);
        setConnBadge(false);
      });
  }

  function maybeSync() {
    if (!state.sb || !state.userId) return;
    var now = Date.now();
    if (now - state.lastSyncAt < SYNC_EVERY_MS) return;
    state.lastSyncAt = now;
    state.sb
      .rpc("log_typing_progress", {
        p_letters: state.lettersCount,
        p_words: state.wordsCount,
      })
      .then(function (res) {
        if (res.error) console.error("Typing Casino: sync failed", res.error);
      });
  }

  function loadAd() {
    if (!state.sb) return;
    state.sb
      .from("ads")
      .select("id, image_url, target_url")
      .eq("active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .then(function (res) {
        if (res.error || !res.data || !res.data.length) return;
        var ad = res.data[0];
        el.adImage.src = ad.image_url;
        el.adLink.href = ad.target_url;
        el.adSlot.style.display = "block";
        el.adLink.onclick = function () {
          state.sb.rpc("register_ad_click", { p_ad_id: ad.id }).then(function () {});
          // navigation proceeds normally (target="_blank"); we don't block it
        };
      });
  }

  // ---- Settings UI ----
  function wireSettingsUi() {
    el.btnOpenSetup.addEventListener("click", function () {
      var isHidden = el.setupPanel.classList.contains("hidden");
      el.setupPanel.classList.toggle("hidden", !isHidden ? true : false);
      el.setupPanel.classList[isHidden ? "remove" : "add"]("hidden");
      el.btnOpenSetup.textContent = isHidden
        ? window.I18N.t("btn-hide-settings")
        : window.I18N.t("btn-settings");
    });

    el.btnSaveSetup.addEventListener("click", function () {
      var url = el.inputUrl.value.trim();
      var key = el.inputKey.value.trim();
      if (!url || !key) {
        alert(window.I18N.t("alert-fill-fields"));
        return;
      }
      saveSupabaseSettings(url, key);
      initSupabase(url, key);
    });
  }

  // ---- Boot ----
  Office.onReady(function () {
    window.I18N.applyStaticText();
    cacheEls();
    wireSettingsUi();
    setConnBadge(false);

    window.Spellcheck.init();

    loadSupabaseSettings().then(function (settings) {
      if (settings.url) el.inputUrl.value = settings.url;
      if (settings.key) el.inputKey.value = settings.key;
      if (settings.url && settings.key) {
        initSupabase(settings.url, settings.key);
      }
    });

    readDocumentText()
      .then(function (text) {
        state.lastText = text; // don't retroactively count text already in the doc
      })
      .finally(function () {
        pollLoop();
      });
  });
})();
