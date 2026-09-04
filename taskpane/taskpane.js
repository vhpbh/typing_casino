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
 *    on-device; they never touch Supabase). The counter/balance you SEE
 *    update instantly (see "instant feedback" below); what's batched is
 *    only the network round-trip that makes it official.
 *  - Concurrency gate: Supabase's free plan caps Realtime at 200 concurrent
 *    connections project-wide. Every active user holds one Realtime
 *    "presence" channel open - that connection *is* the slot. If the
 *    project is already at capacity, the connection attempt fails; the
 *    add-in shows a waiting indicator and retries with backoff until a
 *    slot opens up. That same channel is reused for postgres_changes
 *    subscriptions (balance updates, open-bet lists), so none of that
 *    costs an extra connection either.
 *  - Progress/admin-stats sync is batched to once a minute and skipped
 *    entirely if nothing changed. Currency (cents) earning is batched
 *    separately and faster (see EARN_SYNC_MS) since it gates what you can
 *    actually bet - but it's still a handful of calls a minute, not one
 *    per keystroke.
 *  - The anonymous auth session is reused across app opens instead of
 *    calling signInAnonymously() every time, which would otherwise mint a
 *    brand-new user row (and eat into the monthly-active-users quota) on
 *    every single open of the panel.
 *
 * INSTANT FEEDBACK (word count + balance):
 *  - In addition to the 150ms fallback timer, this add-in listens for
 *    Office's DocumentSelectionChanged event, which fires the moment the
 *    cursor moves - i.e. on essentially every keystroke - and triggers an
 *    immediate re-check instead of waiting for the next timer tick. Word
 *    counting and the balance shown at the top both update the instant a
 *    word is completed; only the "make it official on the server" call
 *    behind it is batched.
 *  - The balance shown at the top is OPTIMISTIC: serverBalance + (letters
 *    typed since the last confirmed earn sync). It's reconciled with the
 *    real, server-confirmed balance every earn sync and via realtime
 *    updates (e.g. after playing a casino game), so it can never drift for
 *    long, but it never makes you wait on a network round trip either.
 */
(function () {
  "use strict";

  var POLL_MS = 150; // local-only fallback timer, no server cost
  var PASTE_CHAR_THRESHOLD = 25;
  var PASTE_MIN_TOKENS = 3;
  var SYNC_EVERY_MS = 60000; // batch admin/stats progress sync to once a minute
  var EARN_SYNC_MS = 5000; // batch currency (cents) earning faster, since it gates betting
  var AD_CACHE_MS = 5 * 60 * 1000; // reuse the last-fetched ad for 5 minutes
  var ROOM_CHANNEL_NAME = "typing-casino-room";
  var BACKOFF_START_MS = 3000;
  var BACKOFF_MAX_MS = 30000;
  var BACKOFF_FACTOR = 1.6;

  // Baked-in project connection, so end users never have to paste anything.
  // The anon key is meant to be public (Row Level Security does the actual
  // access control on the server) - this is the normal, supported way to
  // ship a Supabase anon key inside client-side code.
  var DEFAULT_SUPABASE_URL = "https://cspianjmvwubayrhgcde.supabase.co";
  var DEFAULT_SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNzcGlhbmptdnd1YmF5cmhnY2RlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU2NTgyNTAsImV4cCI6MjEwMTIzNDI1MH0.4fJi68MPa8Bx8qOlHHLiVQKN09zXK89grbo0xxOplTo";

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
    lastEarnSyncedLetters: 0,
    lastEarnSyncAt: 0,
    earnInFlight: false,
    serverBalanceCents: 0,
    sb: null, // supabase client
    userId: null,
    roomConnected: false,
    roomChannel: null,
    roomBackoff: BACKOFF_START_MS,
    pollTimer: null,
    balanceListeners: [],
  };

  var el = {};

  function cacheEls() {
    el.letterCount = document.getElementById("letter-count");
    el.wordsCount = document.getElementById("words-count");
    el.skippedMisspelled = document.getElementById("skipped-misspelled");
    el.skippedPasted = document.getElementById("skipped-pasted");
    el.connBadge = document.getElementById("conn-badge");
    el.waitingBanner = document.getElementById("waiting-banner");
    el.inputName = document.getElementById("input-name");
    el.btnSaveName = document.getElementById("btn-save-name");
    el.adSlot = document.getElementById("ad-slot");
    el.adImage = document.getElementById("ad-image");
    el.adLink = document.getElementById("ad-link");
    el.balanceTop = document.getElementById("balance-top-value");
  }

  function render() {
    el.letterCount.textContent = state.lettersCount.toLocaleString();
    el.wordsCount.textContent = state.wordsCount.toLocaleString();
    el.skippedMisspelled.textContent = state.skippedMisspelled.toLocaleString();
    el.skippedPasted.textContent = state.skippedPasted.toLocaleString();
    renderBalance();
  }

  function currentOptimisticBalanceCents() {
    var pendingLetters = Math.max(0, state.lettersCount - state.lastEarnSyncedLetters);
    return state.serverBalanceCents + pendingLetters;
  }

  function renderBalance() {
    var cents = currentOptimisticBalanceCents();
    if (el.balanceTop) {
      el.balanceTop.textContent = "$" + (cents / 100).toFixed(2);
    }
    state.balanceListeners.forEach(function (fn) {
      try { fn(cents); } catch (e) { /* listener's problem, not ours */ }
    });
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
    if (currentText === last) return false;

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
    return true;
  }

  var checkInFlight = false;
  function checkDocumentNow() {
    if (checkInFlight || !window.Spellcheck.isReady()) return;
    checkInFlight = true;
    readDocumentText()
      .then(function (text) {
        diffAndProcess(text);
        render();
        maybeSync();
        maybeFlushEarnings();
      })
      .catch(function (err) {
        console.error("Typing Casino: failed to read document text", err);
      })
      .finally(function () {
        checkInFlight = false;
      });
  }

  function pollLoop() {
    checkDocumentNow();
    state.pollTimer = setTimeout(pollLoop, POLL_MS);
  }

  // Fires the moment the cursor moves - i.e. on essentially every keystroke -
  // so word count / balance update immediately instead of waiting for the
  // next 150ms timer tick.
  function wireInstantSelectionHandler() {
    try {
      Office.context.document.addHandlerAsync(
        Office.EventType.DocumentSelectionChanged,
        function () {
          checkDocumentNow();
        }
      );
    } catch (e) {
      console.error("Typing Casino: could not register selection handler", e);
    }
  }

  // ---- Fixed project connection (no override, no settings UI) ----
  // This add-in is intentionally wired to one specific Supabase project and
  // nothing else - there is no user-facing way to point it elsewhere.
  function loadSupabaseSettings() {
    return Promise.resolve({ url: DEFAULT_SUPABASE_URL, key: DEFAULT_SUPABASE_ANON_KEY });
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

  // ---- Realtime "room": concurrency gate + presence + postgres_changes ----
  function connectToRoom() {
    if (state.roomChannel) {
      state.sb.removeChannel(state.roomChannel);
      state.roomChannel = null;
    }

    setConnBadge(state.roomBackoff === BACKOFF_START_MS ? "off" : "waiting");

    var channel = state.sb.channel(ROOM_CHANNEL_NAME, {
      config: { presence: { key: state.userId } },
    });

    // Live balance updates (casino wins/losses, earn syncs from *other* open
    // sessions of the same user, etc.) - zero extra polling.
    channel.on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "profiles", filter: "id=eq." + state.userId },
      function (payload) {
        if (payload.new && typeof payload.new.balance_cents === "number") {
          state.serverBalanceCents = payload.new.balance_cents;
          renderBalance();
        }
        if (window.Casino && window.Casino.onProfileRealtimeUpdate) {
          window.Casino.onProfileRealtimeUpdate(payload.new);
        }
      }
    );

    // Casino PvP tables - forwarded to casino.js if it's listening, so open
    // bet/pot lists update live instead of being polled.
    ["bets", "rps_bets", "pots", "pot_entries"].forEach(function (table) {
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table: table },
        function (payload) {
          if (window.Casino && window.Casino.onTableRealtimeUpdate) {
            window.Casino.onTableRealtimeUpdate(table, payload);
          }
        }
      );
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
    loadCasinoProfile();
  }

  // ---- Progress sync (batched + change-gated; admin/stats side, unchanged) ----
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

  // ---- Currency earning (1 cent per letter), batched + flushable on demand ----
  function maybeFlushEarnings() {
    if (!state.roomConnected) return;
    var now = Date.now();
    if (now - state.lastEarnSyncAt < EARN_SYNC_MS) return;
    flushEarnings();
  }

  // Returns a Promise that resolves once any pending letters have been
  // reported (or immediately, if there's nothing to report / a flush is
  // already in flight / we're rate limited). Casino games call this right
  // before wagering, so the balance they're spending from is fresh.
  function flushEarnings() {
    if (!state.sb || !state.userId || state.earnInFlight) return Promise.resolve();
    var pending = state.lettersCount - state.lastEarnSyncedLetters;
    if (pending <= 0) return Promise.resolve();

    state.earnInFlight = true;
    state.lastEarnSyncAt = Date.now();
    var claimedLetters = state.lettersCount;

    return state.sb
      .rpc("earn_from_typing_letters", { p_letters: pending })
      .then(function (res) {
        state.earnInFlight = false;
        if (res.error) {
          // Rate limited or otherwise failed - the optimistic balance still
          // covers the user visually; we'll retry on the next tick.
          return;
        }
        state.serverBalanceCents = Number(res.data) || state.serverBalanceCents;
        state.lastEarnSyncedLetters = claimedLetters;
        renderBalance();
      })
      .catch(function () {
        state.earnInFlight = false;
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

  // Pull this user's casino profile (username + real balance) once per
  // session; the trigger in casino_schema.sql already created it.
  function loadCasinoProfile() {
    state.sb
      .from("profiles")
      .select("username, balance_cents")
      .eq("id", state.userId)
      .single()
      .then(function (res) {
        if (res.error || !res.data) return;
        state.serverBalanceCents = Number(res.data.balance_cents) || 0;
        state.lastEarnSyncedLetters = state.lettersCount; // don't re-award what's already reflected
        if (!el.inputName.value && res.data.username) {
          el.inputName.value = res.data.username;
        }
        renderBalance();
        if (window.Casino && window.Casino.onProfileLoaded) {
          window.Casino.onProfileLoaded(res.data);
        }
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

  // ---- Display name (updates BOTH the stats/admin name and the casino
  //      leaderboard username, from the one input) ----
  function wireNameUi() {
    el.btnSaveName.addEventListener("click", function () {
      var name = el.inputName.value.trim();
      if (!state.sb || !state.userId || !name) return;

      Promise.all([
        state.sb.rpc("set_display_name", { p_name: name }),
        state.sb.rpc("set_username", { p_username: name }),
      ]).then(function (results) {
        var usernameRes = results[1];
        if (usernameRes && !usernameRes.error && usernameRes.data) {
          el.inputName.value = usernameRes.data; // reflect any de-dupe suffix
        }
        var original = el.btnSaveName.textContent;
        el.btnSaveName.textContent = window.I18N.t("name-saved");
        setTimeout(function () {
          el.btnSaveName.textContent = original;
        }, 1200);
      });
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

  // Best-effort final sync so the last unsynced words/letters aren't lost.
  // This is "fire and forget" - the page may close before it completes, and
  // that's an acceptable tradeoff against polling the server more often.
  function wireFinalSync() {
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") {
        maybeSync(true);
        flushEarnings();
      }
    });
    window.addEventListener("pagehide", function () {
      maybeSync(true);
      flushEarnings();
    });
  }

  // ---- Public API for casino.js (kept intentionally small) ----
  window.TypingCasinoCore = {
    getClient: function () { return state.sb; },
    getUserId: function () { return state.userId; },
    isRoomConnected: function () { return state.roomConnected; },
    getOptimisticBalanceCents: currentOptimisticBalanceCents,
    flushEarnings: flushEarnings,
    onBalanceChange: function (fn) { state.balanceListeners.push(fn); },
    __setServerBalance: function (cents) {
      if (typeof cents === "number") {
        state.serverBalanceCents = cents;
        renderBalance();
      }
    },
  };

  // ---- Boot ----
  Office.onReady(function () {
    window.I18N.applyStaticText();
    cacheEls();
    wireNameUi();
    wireFinalSync();
    wireInstantSelectionHandler();
    setConnBadge("off");

    window.Spellcheck.init();

    loadSupabaseSettings().then(function (settings) {
      initSupabase(settings.url, settings.key);
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
