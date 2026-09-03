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
 *       - Typed vs. pasted: a short-interval LOCAL polling loop (no server
 *         calls involved) diffs the document's text. A large chunk of new
 *         text appearing between two polls (many words at once) is treated
 *         as a paste and excluded. A human typing normally only ever adds
 *         a word or two between polls, so this is a reliable heuristic in
 *         practice but not a mathematical guarantee.
 *  2. If text is edited in the *middle* of the document (not appended at
 *     the end), this build simply re-syncs its baseline on the next poll
 *     without counting or penalizing anything from that edit.
 *
 * SERVER-LOAD / SCALE DESIGN (read before changing the numbers below):
 *  - Word-counting and paste-detection are 100% local (Word.run calls stay
 *    on-device; they never touch Supabase). Only three things ever hit the
 *    network: (a) one Realtime "room" connection per active user used to
 *    both gate concurrency AND announce presence, (b) an infrequent batched
 *    progress sync, and (c) reading/clicking the single ad slot.
 *  - Concurrency gate: Supabase's free plan caps Realtime at 200 concurrent
 *    connections project-wide. Rather than build a separate queuing table
 *    (which would itself cost reads/writes for every single user), this
 *    add-in *reuses that exact limit as the gate*: every active user holds
 *    one Realtime "presence" channel open. If the project is already at
 *    capacity, the connection attempt fails; the add-in then shows the
 *    waiting indicator and retries with backoff until a slot opens up -
 *    exactly the "201st user waits for the 1st to leave" behavior asked
 *    for, with zero extra database load.
 *  - Progress sync is batched to once a minute AND skipped entirely if
 *    nothing changed since the last sync, so an idle or slow typist costs
 *    the server nothing. A best-effort final sync also fires on page
 *    unload so the very last few words aren't lost.
 *  - The anonymous auth session is reused across app opens (Supabase persists
 *    it in local storage) instead of calling signInAnonymously() every time,
 *    which would otherwise silently create a brand-new user row - and count
 *    against the project's monthly-active-users quota - on every single
 *    open of the panel.
 */
(function () {
  "use strict";

  var POLL_MS = 300; // local only, no server cost
  var PASTE_CHAR_THRESHOLD = 25;
  var PASTE_MIN_TOKENS = 3;
  var SYNC_EVERY_MS = 60000; // batch progress sync to once a minute
  var AD_CACHE_MS = 5 * 60 * 1000; // reuse the last-fetched ad for 5 minutes
  var ROOM_CHANNEL_NAME = "typing-casino-room";
  var BACKOFF_START_MS = 3000;
  var BACKOFF_MAX_MS = 30000;
  var BACKOFF_FACTOR = 1.6;

  var state = {
    lastText: "",
    pendingBuffer: "",
    lettersCount: 0,
    wordsCount: 0,
    skippedMisspelled: 0,
    skippedPasted: 0,
    lastSyncedLetters: -1,
    lastSyncedWords: -1,
    lastSyncAt: 0,
    sb: null, // supabase client
    userId: null,
    roomConnected: false,
    roomChannel: null,
    roomBackoff: BACKOFF_START_MS,
  };

  var el = {};

  function cacheEls() {
    el.letterCount = document.getElementById("letter-count");
    el.wordsCount = document.getElementById("words-count");
    el.skippedMisspelled = document.getElementById("skipped-misspelled");
    el.skippedPasted = document.getElementById("skipped-pasted");
    el.connBadge = document.getElementById("conn-badge");
    el.waitingBanner = document.getElementById("waiting-banner");
    el.setupPanel = document.getElementById("setup-panel");
    el.btnOpenSetup = document.getElementById("btn-open-setup");
    el.btnSaveSetup = document.getElementById("btn-save-setup");
    el.inputUrl = document.getElementById("input-url");
    el.inputKey = document.getElementById("input-key");
    el.inputName = document.getElementById("input-name");
    el.btnSaveName = document.getElementById("btn-save-name");
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

  // status: "off" | "waiting" | "on"
  function setConnBadge(status) {
    var key = status === "on" ? "conn-on" : status === "waiting" ? null : "conn-off";
    el.connBadge.textContent = key ? window.I18N.t(key) : window.I18N.t("waiting-text").slice(0, 24) + "…";
    el.connBadge.className = "badge " + (status === "on" ? "badge-on" : status === "waiting" ? "badge-off" : "badge-off");
    el.waitingBanner.classList.toggle("hidden", status !== "waiting");
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

    var endsWithBoundary = /\s$/.test(state.pendingBuffer);
    var tokens = tokenize(state.pendingBuffer);

    var completed = endsWithBoundary ? tokens : tokens.slice(0, -1);
    state.pendingBuffer = endsWithBoundary ? "" : (tokens.length ? tokens[tokens.length - 1] : "");

    completed.forEach(function (raw) {
      var word = cleanToken(raw);
      if (!word) return;

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
      var segment = currentText.slice(last.length);
      var segTokens = tokenize(segment);
      var looksLikePaste =
        (segment.length > PASTE_CHAR_THRESHOLD && segTokens.length >= 2) ||
        segTokens.length >= PASTE_MIN_TOKENS;
      processSegment(segment, looksLikePaste);
    }
    // Edits elsewhere in the document: just resync, see file header note #2.

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

  // ---- Local settings (Office roaming settings; no server cost) ----
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

  // ---- Auth: reuse the persisted anonymous session instead of minting a
  //      brand-new user (and burning a monthly-active-user slot) every time
  //      the panel is opened. ----
  function ensureSession() {
    return state.sb.auth.getSession().then(function (res) {
      var session = res.data && res.data.session;
      if (session && session.user) {
        return session.user.id;
      }
      return state.sb.auth.signInAnonymously().then(function (signInRes) {
        if (signInRes.error) throw signInRes.error;
        return signInRes.data.user.id;
      });
    });
  }

  // ---- Realtime "room": doubles as the concurrency gate and presence ----
  function connectToRoom() {
    if (state.roomChannel) {
      state.sb.removeChannel(state.roomChannel);
      state.roomChannel = null;
    }

    setConnBadge(state.roomBackoff === BACKOFF_START_MS ? "off" : "waiting");

    var channel = state.sb.channel(ROOM_CHANNEL_NAME, {
      config: { presence: { key: state.userId } },
    });
    state.roomChannel = channel;

    channel.subscribe(function (status) {
      if (status === "SUBSCRIBED") {
        channel.track({ online_at: new Date().toISOString() });
        state.roomBackoff = BACKOFF_START_MS;
        state.roomConnected = true;
        setConnBadge("on");
        onRoomConnected();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        state.roomConnected = false;
        setConnBadge("waiting");
        scheduleRoomRetry();
      }
    });
  }

  function scheduleRoomRetry() {
    var delay = state.roomBackoff + Math.random() * 500;
    state.roomBackoff = Math.min(state.roomBackoff * BACKOFF_FACTOR, BACKOFF_MAX_MS);
    setTimeout(connectToRoom, delay);
  }

  // Runs once, the first time this session successfully claims a room slot.
  var roomConnectedOnce = false;
  function onRoomConnected() {
    if (roomConnectedOnce) return;
    roomConnectedOnce = true;
    loadMyStats();
    loadAd();
  }

  // ---- Progress sync (batched + change-gated) ----
  function maybeSync(force) {
    if (!state.sb || !state.userId || !state.roomConnected) return;
    var now = Date.now();
    if (!force && now - state.lastSyncAt < SYNC_EVERY_MS) return;
    if (state.lettersCount === state.lastSyncedLetters && state.wordsCount === state.lastSyncedWords) {
      return; // nothing changed - skip the call entirely
    }
    state.lastSyncAt = now;
    var letters = state.lettersCount;
    var words = state.wordsCount;
    state.sb
      .rpc("log_typing_progress", { p_letters: letters, p_words: words })
      .then(function (res) {
        if (res.error) {
          console.error("Typing Casino: sync failed", res.error);
          return;
        }
        state.lastSyncedLetters = letters;
        state.lastSyncedWords = words;
      });
  }

  // Pull this user's previously-saved totals + name once per session, so
  // reopening the panel doesn't visually reset progress to zero (the server
  // never lost it - the local counter just didn't know about it yet).
  function loadMyStats() {
    state.sb.rpc("get_my_stats").then(function (res) {
      if (res.error || !res.data || !res.data.length) return;
      var row = res.data[0];
      if (row.display_name) el.inputName.value = row.display_name;
      state.lettersCount = Math.max(state.lettersCount, Number(row.letters_typed) || 0);
      state.wordsCount = Math.max(state.wordsCount, Number(row.words_typed) || 0);
      state.lastSyncedLetters = state.lettersCount;
      state.lastSyncedWords = state.wordsCount;
      render();
    });
  }

  // ---- Ad slot (fetched once per session, cached briefly across reopens) ----
  function loadAd() {
    var cacheRaw = sessionStorage.getItem("tc_ad_cache");
    if (cacheRaw) {
      try {
        var cached = JSON.parse(cacheRaw);
        if (Date.now() - cached.at < AD_CACHE_MS) {
          showAd(cached.ad);
          return;
        }
      } catch (e) { /* ignore malformed cache */ }
    }

    state.sb
      .from("ads")
      .select("id, image_url, target_url")
      .eq("active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .then(function (res) {
        if (res.error || !res.data || !res.data.length) return;
        var ad = res.data[0];
        sessionStorage.setItem("tc_ad_cache", JSON.stringify({ ad: ad, at: Date.now() }));
        showAd(ad);
      });
  }

  function showAd(ad) {
    el.adImage.src = ad.image_url;
    el.adLink.href = ad.target_url;
    el.adSlot.style.display = "block";
    el.adLink.onclick = function () {
      state.sb.rpc("register_ad_click", { p_ad_id: ad.id }).then(function () {});
    };
  }

  // ---- Display name ----
  function wireNameUi() {
    el.btnSaveName.addEventListener("click", function () {
      var name = el.inputName.value.trim();
      if (!state.sb || !state.userId) return;
      state.sb.rpc("set_display_name", { p_name: name }).then(function (res) {
        if (res.error) {
          console.error("Typing Casino: could not save name", res.error);
          return;
        }
        var original = el.btnSaveName.textContent;
        el.btnSaveName.textContent = window.I18N.t("name-saved");
        setTimeout(function () {
          el.btnSaveName.textContent = original;
        }, 1200);
      });
    });
  }

  // ---- Setup UI ----
  function wireSettingsUi() {
    el.btnOpenSetup.addEventListener("click", function () {
      var isHidden = el.setupPanel.classList.contains("hidden");
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

  function initSupabase(url, key) {
    if (!url || !key) {
      setConnBadge("off");
      return Promise.resolve();
    }
    state.sb = window.supabase.createClient(url, key);
    return ensureSession()
      .then(function (userId) {
        state.userId = userId;
        state.roomBackoff = BACKOFF_START_MS;
        connectToRoom();
      })
      .catch(function (err) {
        console.error("Typing Casino: Supabase connection failed", err);
        setConnBadge("off");
      });
  }

  // Best-effort final sync so the last unsynced words aren't lost. This is
  // "fire and forget" - the page may close before it completes, and that's
  // an acceptable tradeoff against polling the server more often.
  function wireFinalSync() {
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") maybeSync(true);
    });
    window.addEventListener("pagehide", function () {
      maybeSync(true);
    });
  }

  // ---- Boot ----
  Office.onReady(function () {
    window.I18N.applyStaticText();
    cacheEls();
    wireSettingsUi();
    wireNameUi();
    wireFinalSync();
    setConnBadge("off");

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
