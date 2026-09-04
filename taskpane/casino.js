/*
 * casino.js
 * All ten game types from the original Obsidian plugin, ported to this
 * taskpane. Every outcome is decided server-side (see supabase/casino_schema.sql);
 * this file only renders UI, collects input, calls the RPCs, and displays results.
 *
 * Depends on window.TypingCasinoCore (defined in taskpane.js) for the
 * Supabase client, the user id, and the batched-earnings flush - it does not
 * duplicate or touch any of that logic.
 */
(function () {
  "use strict";

  var Core = null; // set on init, once TypingCasinoCore exists
  var container = null;
  var select = null;
  var leaderboardContainer = null;
  var currentGameId = null;
  var openListsPollTimers = {}; // gameId -> interval id, only while that tab is open

  function t(key) { return window.I18N.t(key); }
  function sb() { return Core.getClient(); }
  function uid() { return Core.getUserId(); }
  function fmtCents(c) { return "$" + (Number(c || 0) / 100).toFixed(2); }

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function resultBanner(kind, text) {
    // kind: "win" | "lose" | "push" | "info"
    var d = el("div", "cx-result cx-result-" + kind, text);
    return d;
  }

  // Every wager first flushes any pending letter-earnings so the balance
  // being spent from is fresh, then reads the just-confirmed balance.
  function withFreshBalance(cb) {
    Core.flushEarnings().then(function () {
      cb();
    });
  }

  function stakeInputRow(defaultCents) {
    var row = el("div", "cx-row");
    var label = el("label", "cx-label", t("cx-stake"));
    var input = el("input", "cx-input");
    input.type = "number";
    input.min = "1";
    input.step = "1";
    input.value = String(Math.max(1, Math.round((defaultCents || 100))));
    row.appendChild(label);
    row.appendChild(input);
    return { row: row, input: input };
  }

  function showRpcError(target, err) {
    var msg = (err && err.message) || String(err);
    if (/insufficient balance/i.test(msg)) msg = t("cx-insufficient");
    else if (/rate limited/i.test(msg)) msg = t("cx-rate-limited");
    else if (!msg) msg = t("cx-error");
    target.appendChild(resultBanner("lose", msg));
  }

  // ============================================================ GAME LIST

  var GAMES = [
    { id: "wheel", nameKey: "cx-game-wheel", render: renderWheel },
    { id: "coinflip", nameKey: "cx-game-coinflip", render: renderCoinflipHouse },
    { id: "dice", nameKey: "cx-game-dice", render: renderDiceHouse },
    { id: "slots", nameKey: "cx-game-slots", render: renderSlots },
    { id: "crash", nameKey: "cx-game-crash", render: renderCrash },
    { id: "hilo", nameKey: "cx-game-hilo", render: renderHilo },
    { id: "pvp_coinflip", nameKey: "cx-game-pvp-coinflip", render: renderPvpBets.bind(null, "coinflip") },
    { id: "pvp_dice", nameKey: "cx-game-pvp-dice", render: renderPvpBets.bind(null, "dice") },
    { id: "rps", nameKey: "cx-game-rps", render: renderRps },
    { id: "pot", nameKey: "cx-game-pot", render: renderPot },
  ];

  function buildSelect() {
    select.innerHTML = "";
    GAMES.forEach(function (g) {
      var opt = document.createElement("option");
      opt.value = g.id;
      opt.textContent = t(g.nameKey);
      select.appendChild(opt);
    });
  }

  function showGame(id) {
    stopOpenListPolling();
    currentGameId = id;
    container.innerHTML = "";
    var game = GAMES.filter(function (g) { return g.id === id; })[0];
    if (game) game.render(container);
  }

  function stopOpenListPolling() {
    Object.keys(openListsPollTimers).forEach(function (k) {
      clearInterval(openListsPollTimers[k]);
      delete openListsPollTimers[k];
    });
  }

  // ============================================================ HOUSE GAMES

  function renderWheel(root) {
    var sr = stakeInputRow(100);
    var btn = el("button", "btn-primary cx-btn", t("cx-wheel-spin"));
    var out = el("div", "cx-out");
    root.appendChild(sr.row);
    root.appendChild(btn);
    root.appendChild(out);

    btn.addEventListener("click", function () {
      var stake = parseInt(sr.input.value, 10);
      if (!stake || stake <= 0) return;
      btn.disabled = true;
      out.innerHTML = "";
      withFreshBalance(function () {
        sb().rpc("spin_wheel", { p_stake: stake }).then(function (res) {
          btn.disabled = false;
          if (res.error) return showRpcError(out, res.error);
          var row = Array.isArray(res.data) ? res.data[0] : res.data;
          var label = row.segment_label === "BUST" ? t("cx-seg-bust") :
                      row.segment_label === "JACKPOT" ? t("cx-seg-jackpot") : row.segment_label;
          var kind = row.payout_cents > stake ? "win" : row.payout_cents > 0 ? "push" : "lose";
          out.innerHTML = "";
          out.appendChild(resultBanner(kind, label + " · " + fmtCents(row.payout_cents)));
          onBalanceKnown(row.new_balance);
        });
      });
    });
  }

  function renderCoinflipHouse(root) {
    var sr = stakeInputRow(100);
    var choiceRow = el("div", "cx-row");
    var choice = "heads";
    var headsBtn = el("button", "cx-toggle cx-toggle-active", t("cx-heads"));
    var tailsBtn = el("button", "cx-toggle", t("cx-tails"));
    headsBtn.addEventListener("click", function () {
      choice = "heads"; headsBtn.className = "cx-toggle cx-toggle-active"; tailsBtn.className = "cx-toggle";
    });
    tailsBtn.addEventListener("click", function () {
      choice = "tails"; tailsBtn.className = "cx-toggle cx-toggle-active"; headsBtn.className = "cx-toggle";
    });
    choiceRow.appendChild(headsBtn);
    choiceRow.appendChild(tailsBtn);

    var btn = el("button", "btn-primary cx-btn", t("cx-play"));
    var out = el("div", "cx-out");
    root.appendChild(sr.row);
    root.appendChild(choiceRow);
    root.appendChild(btn);
    root.appendChild(out);

    btn.addEventListener("click", function () {
      var stake = parseInt(sr.input.value, 10);
      if (!stake || stake <= 0) return;
      btn.disabled = true;
      withFreshBalance(function () {
        sb().rpc("play_coinflip_house", { p_stake: stake, p_choice: choice }).then(function (res) {
          btn.disabled = false;
          if (res.error) return showRpcError(out, res.error);
          var row = Array.isArray(res.data) ? res.data[0] : res.data;
          var won = row.payout_cents > 0;
          var label = (row.result === "heads" ? t("cx-heads") : t("cx-tails")) + " · " +
            (won ? t("cx-win") : t("cx-lose")) + " · " + fmtCents(row.payout_cents);
          out.innerHTML = "";
          out.appendChild(resultBanner(won ? "win" : "lose", label));
          onBalanceKnown(row.new_balance);
        });
      });
    });
  }

  function renderDiceHouse(root) {
    var sr = stakeInputRow(100);
    var row2 = el("div", "cx-row");
    var label2 = el("label", "cx-label", t("cx-roll-under"));
    var range = el("input", "cx-input");
    range.type = "number"; range.min = "2"; range.max = "98"; range.value = "50";
    row2.appendChild(label2); row2.appendChild(range);

    var btn = el("button", "btn-primary cx-btn", t("cx-play"));
    var out = el("div", "cx-out");
    root.appendChild(sr.row);
    root.appendChild(row2);
    root.appendChild(btn);
    root.appendChild(out);

    btn.addEventListener("click", function () {
      var stake = parseInt(sr.input.value, 10);
      var under = parseInt(range.value, 10);
      if (!stake || stake <= 0 || !under || under < 2 || under > 98) return;
      btn.disabled = true;
      withFreshBalance(function () {
        sb().rpc("play_dice_house", { p_stake: stake, p_roll_under: under }).then(function (res) {
          btn.disabled = false;
          if (res.error) return showRpcError(out, res.error);
          var r = Array.isArray(res.data) ? res.data[0] : res.data;
          var label = t("cx-roll-result") + ": " + r.roll + " · " +
            (r.won ? t("cx-win") : t("cx-lose")) + " · " + fmtCents(r.payout_cents);
          out.innerHTML = "";
          out.appendChild(resultBanner(r.won ? "win" : "lose", label));
          onBalanceKnown(r.new_balance);
        });
      });
    });
  }

  function renderSlots(root) {
    var sr = stakeInputRow(100);
    var btn = el("button", "btn-primary cx-btn", t("cx-play"));
    var reels = el("div", "cx-reels", "🍒 🍋 🔔");
    var out = el("div", "cx-out");
    root.appendChild(sr.row);
    root.appendChild(reels);
    root.appendChild(btn);
    root.appendChild(out);

    btn.addEventListener("click", function () {
      var stake = parseInt(sr.input.value, 10);
      if (!stake || stake <= 0) return;
      btn.disabled = true;
      withFreshBalance(function () {
        sb().rpc("play_slots_house", { p_stake: stake }).then(function (res) {
          btn.disabled = false;
          if (res.error) return showRpcError(out, res.error);
          var r = Array.isArray(res.data) ? res.data[0] : res.data;
          reels.textContent = r.reels.join("  ");
          var won = r.payout_cents > stake;
          out.innerHTML = "";
          out.appendChild(resultBanner(won ? "win" : r.payout_cents > 0 ? "push" : "lose", fmtCents(r.payout_cents)));
          onBalanceKnown(r.new_balance);
        });
      });
    });
  }

  function renderCrash(root) {
    var sr = stakeInputRow(100);
    var row2 = el("div", "cx-row");
    var label2 = el("label", "cx-label", t("cx-cashout-at"));
    var cashout = el("input", "cx-input");
    cashout.type = "number"; cashout.min = "1.01"; cashout.max = "100"; cashout.step = "0.01"; cashout.value = "2.00";
    row2.appendChild(label2); row2.appendChild(cashout);

    var btn = el("button", "btn-primary cx-btn", t("cx-play"));
    var out = el("div", "cx-out");
    root.appendChild(sr.row);
    root.appendChild(row2);
    root.appendChild(btn);
    root.appendChild(out);

    btn.addEventListener("click", function () {
      var stake = parseInt(sr.input.value, 10);
      var target = parseFloat(cashout.value);
      if (!stake || stake <= 0 || !target || target < 1.01) return;
      btn.disabled = true;
      withFreshBalance(function () {
        sb().rpc("play_crash_house", { p_stake: stake, p_cashout_at: target }).then(function (res) {
          btn.disabled = false;
          if (res.error) return showRpcError(out, res.error);
          var r = Array.isArray(res.data) ? res.data[0] : res.data;
          var label = t("cx-crash-point") + r.crash_point + " · " +
            (r.won ? t("cx-win") : t("cx-lose")) + " · " + fmtCents(r.payout_cents);
          out.innerHTML = "";
          out.appendChild(resultBanner(r.won ? "win" : "lose", label));
          onBalanceKnown(r.new_balance);
        });
      });
    });
  }

  function renderHilo(root) {
    var sr = stakeInputRow(100);
    var startBtn = el("button", "btn-primary cx-btn", t("cx-hilo-start"));
    var out = el("div", "cx-out");
    var guessRow = el("div", "cx-row hidden");
    var higherBtn = el("button", "cx-toggle", t("cx-higher"));
    var lowerBtn = el("button", "cx-toggle", t("cx-lower"));
    guessRow.appendChild(higherBtn);
    guessRow.appendChild(lowerBtn);

    root.appendChild(sr.row);
    root.appendChild(startBtn);
    root.appendChild(guessRow);
    root.appendChild(out);

    var roundId = null;

    function guess(direction) {
      if (!roundId) return;
      higherBtn.disabled = true; lowerBtn.disabled = true;
      sb().rpc("guess_hilo_house", { p_round_id: roundId, p_guess: direction }).then(function (res) {
        higherBtn.disabled = false; lowerBtn.disabled = false;
        if (res.error) return showRpcError(out, res.error);
        var r = Array.isArray(res.data) ? res.data[0] : res.data;
        var kind = r.outcome === "win" ? "win" : r.outcome === "push" ? "push" : "lose";
        var label = t("cx-hilo-card") + " B: " + r.card_b + " · " +
          (r.outcome === "win" ? t("cx-hilo-outcome-win") : r.outcome === "push" ? t("cx-hilo-outcome-push") : t("cx-hilo-outcome-lose")) +
          " · " + fmtCents(r.payout_cents);
        out.innerHTML = "";
        out.appendChild(resultBanner(kind, label));
        onBalanceKnown(r.new_balance);
        roundId = null;
        guessRow.classList.add("hidden");
        startBtn.classList.remove("hidden");
      });
    }
    higherBtn.addEventListener("click", function () { guess("higher"); });
    lowerBtn.addEventListener("click", function () { guess("lower"); });

    startBtn.addEventListener("click", function () {
      var stake = parseInt(sr.input.value, 10);
      if (!stake || stake <= 0) return;
      startBtn.disabled = true;
      withFreshBalance(function () {
        sb().rpc("start_hilo_house", { p_stake: stake }).then(function (res) {
          startBtn.disabled = false;
          if (res.error) return showRpcError(out, res.error);
          var r = Array.isArray(res.data) ? res.data[0] : res.data;
          roundId = r.round_id;
          out.innerHTML = "";
          out.appendChild(resultBanner("info", t("cx-hilo-card") + " A: " + r.card));
          guessRow.classList.remove("hidden");
          startBtn.classList.add("hidden");
          onBalanceKnown(r.new_balance);
        });
      });
    });
  }

  function onBalanceKnown(newBalanceCents) {
    if (typeof newBalanceCents === "number" && window.TypingCasinoCore.__setServerBalance) {
      window.TypingCasinoCore.__setServerBalance(newBalanceCents);
    }
  }

  // ============================================================ PVP: 1v1 bets

  function renderPvpBets(mode, root) {
    var createRow = el("div", "cx-row");
    var sr = stakeInputRow(100);
    var createBtn = el("button", "btn-primary cx-btn cx-btn-compact", t("cx-create"));
    createRow.appendChild(sr.row);
    createRow.appendChild(createBtn);

    var list = el("div", "cx-list");
    var out = el("div", "cx-out");

    root.appendChild(createRow);
    root.appendChild(out);
    root.appendChild(el("div", "cx-subheading", t("cx-open-bets")));
    root.appendChild(list);

    function refresh() {
      if (!sb()) return;
      sb().from("bets")
        .select("id, mode, creator_id, stake_cents, status, created_at")
        .eq("status", "open")
        .eq("mode", mode)
        .order("created_at", { ascending: false })
        .limit(25)
        .then(function (res) {
          list.innerHTML = "";
          if (res.error || !res.data || !res.data.length) {
            list.appendChild(el("div", "cx-empty", t("cx-empty")));
            return;
          }
          res.data.forEach(function (bet) {
            var row = el("div", "cx-list-row");
            var isMine = bet.creator_id === uid();
            row.appendChild(el("span", "cx-list-stake", fmtCents(bet.stake_cents) + (isMine ? " " + t("cx-you") : "")));
            var actionBtn = el("button", "cx-toggle", isMine ? t("cx-cancel") : t("cx-join"));
            actionBtn.addEventListener("click", function () {
              actionBtn.disabled = true;
              var call = isMine
                ? sb().rpc("cancel_pvp_bet", { p_bet_id: bet.id })
                : Core.flushEarnings().then(function () { return sb().rpc("join_pvp_bet", { p_bet_id: bet.id }); });
              Promise.resolve(call).then(function (res2) {
                actionBtn.disabled = false;
                if (res2.error) return showRpcError(out, res2.error);
                if (!isMine) {
                  var winnerId = res2.data;
                  out.innerHTML = "";
                  if (winnerId === null) {
                    out.appendChild(resultBanner("push", t("cx-push")));
                  } else {
                    var won = winnerId === uid();
                    out.appendChild(resultBanner(won ? "win" : "lose", won ? t("cx-win") : t("cx-lose")));
                  }
                }
                refresh();
              });
            });
            row.appendChild(actionBtn);
            list.appendChild(row);
          });
        });
    }

    createBtn.addEventListener("click", function () {
      var stake = parseInt(sr.input.value, 10);
      if (!stake || stake <= 0) return;
      createBtn.disabled = true;
      withFreshBalance(function () {
        sb().rpc("create_pvp_bet", { p_stake: stake, p_mode: mode }).then(function (res) {
          createBtn.disabled = false;
          if (res.error) return showRpcError(out, res.error);
          refresh();
        });
      });
    });

    refresh();
    // Realtime pushes (see taskpane.js) call window.Casino.onTableRealtimeUpdate;
    // as a safety net (e.g. before Realtime replication is enabled on a fresh
    // project) also refresh on a slow interval while this tab is open.
    openListsPollTimers.pvp = setInterval(refresh, 8000);
    window.Casino._refreshCurrentList = refresh;
  }

  // ============================================================ PVP: Rock-Paper-Scissors

  function rpsSaltKey(betId) { return "tc_rps_salt_" + betId; }

  function renderRps(root) {
    var createRow = el("div", "cx-row");
    var sr = stakeInputRow(100);
    var moveSelect = document.createElement("select");
    ["rock", "paper", "scissors"].forEach(function (m) {
      var opt = document.createElement("option");
      opt.value = m;
      opt.textContent = t("cx-rps-" + m);
      moveSelect.appendChild(opt);
    });
    var createBtn = el("button", "btn-primary cx-btn cx-btn-compact", t("cx-create"));
    createRow.appendChild(sr.row);
    createRow.appendChild(moveSelect);
    createRow.appendChild(createBtn);

    var note = el("div", "cx-note", t("cx-rps-remember"));
    var out = el("div", "cx-out");
    var list = el("div", "cx-list");

    root.appendChild(createRow);
    root.appendChild(note);
    root.appendChild(out);
    root.appendChild(el("div", "cx-subheading", t("cx-open-bets")));
    root.appendChild(list);

    function sha256Hex(input) {
      var enc = new TextEncoder().encode(input);
      return crypto.subtle.digest("SHA-256", enc).then(function (digest) {
        return Array.from(new Uint8Array(digest)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
      });
    }
    function randomSalt() {
      var arr = new Uint8Array(16);
      crypto.getRandomValues(arr);
      return Array.from(arr).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    }

    function refresh() {
      if (!sb()) return;
      sb().from("rps_bets")
        .select("id, creator_id, opponent_id, stake_cents, status, created_at")
        .in("status", ["open", "awaiting_reveal"])
        .order("created_at", { ascending: false })
        .limit(25)
        .then(function (res) {
          list.innerHTML = "";
          if (res.error || !res.data || !res.data.length) {
            list.appendChild(el("div", "cx-empty", t("cx-empty")));
            return;
          }
          res.data.forEach(function (bet) {
            var row = el("div", "cx-list-row");
            var isMine = bet.creator_id === uid();
            row.appendChild(el("span", "cx-list-stake", fmtCents(bet.stake_cents) + (isMine ? " " + t("cx-you") : "")));

            if (isMine && bet.status === "open") {
              row.appendChild(el("span", "cx-note-inline", t("cx-rps-waiting-reveal")));
              var cancelBtn = el("button", "cx-toggle", t("cx-cancel"));
              cancelBtn.addEventListener("click", function () {
                sb().rpc("cancel_rps_bet", { p_id: bet.id }).then(function (res2) {
                  if (res2.error) return showRpcError(out, res2.error);
                  refresh();
                });
              });
              row.appendChild(cancelBtn);
            } else if (isMine && bet.status === "awaiting_reveal") {
              var revealBtn = el("button", "cx-toggle cx-toggle-active", t("cx-reveal"));
              revealBtn.addEventListener("click", function () {
                var saved;
                try { saved = JSON.parse(localStorage.getItem(rpsSaltKey(bet.id))); } catch (e2) { saved = null; }
                if (!saved) {
                  out.innerHTML = "";
                  out.appendChild(resultBanner("lose", t("cx-error")));
                  return;
                }
                sb().rpc("reveal_rps_bet", { p_id: bet.id, p_move: saved.move, p_salt: saved.salt }).then(function (res2) {
                  if (res2.error) return showRpcError(out, res2.error);
                  localStorage.removeItem(rpsSaltKey(bet.id));
                  var winnerId = res2.data;
                  out.innerHTML = "";
                  if (winnerId === null) out.appendChild(resultBanner("push", t("cx-push")));
                  else out.appendChild(resultBanner(winnerId === uid() ? "win" : "lose", winnerId === uid() ? t("cx-win") : t("cx-lose")));
                  refresh();
                });
              });
              row.appendChild(revealBtn);
            } else if (!isMine && bet.status === "open") {
              var joinSelect = document.createElement("select");
              ["rock", "paper", "scissors"].forEach(function (m) {
                var opt = document.createElement("option");
                opt.value = m; opt.textContent = t("cx-rps-" + m);
                joinSelect.appendChild(opt);
              });
              var joinBtn = el("button", "cx-toggle", t("cx-join"));
              joinBtn.addEventListener("click", function () {
                joinBtn.disabled = true;
                Core.flushEarnings().then(function () {
                  return sb().rpc("join_rps_bet", { p_id: bet.id, p_move: joinSelect.value });
                }).then(function (res2) {
                  joinBtn.disabled = false;
                  if (res2.error) return showRpcError(out, res2.error);
                  out.innerHTML = "";
                  out.appendChild(resultBanner("info", t("cx-rps-waiting-reveal")));
                  refresh();
                });
              });
              row.appendChild(joinSelect);
              row.appendChild(joinBtn);
            } else {
              row.appendChild(el("span", "cx-note-inline", t("cx-rps-waiting-reveal")));
            }

            list.appendChild(row);
          });
        });
    }

    createBtn.addEventListener("click", function () {
      var stake = parseInt(sr.input.value, 10);
      if (!stake || stake <= 0) return;
      var move = moveSelect.value;
      var salt = randomSalt();
      createBtn.disabled = true;
      withFreshBalance(function () {
        sha256Hex(move + ":" + salt).then(function (hash) {
          sb().rpc("create_rps_bet", { p_stake: stake, p_move_hash: hash }).then(function (res) {
            createBtn.disabled = false;
            if (res.error) return showRpcError(out, res.error);
            localStorage.setItem(rpsSaltKey(res.data), JSON.stringify({ move: move, salt: salt }));
            refresh();
          });
        });
      });
    });

    refresh();
    openListsPollTimers.rps = setInterval(refresh, 8000);
    window.Casino._refreshCurrentList = refresh;
  }

  // ============================================================ PVP: Group Pot

  function renderPot(root) {
    var createBtn = el("button", "btn-primary cx-btn cx-btn-compact", t("cx-pot-create"));
    var out = el("div", "cx-out");
    var list = el("div", "cx-list");
    root.appendChild(createBtn);
    root.appendChild(out);
    root.appendChild(list);

    function refresh() {
      if (!sb()) return;
      sb().from("pots")
        .select("id, status, total_cents, created_at")
        .eq("status", "open")
        .order("created_at", { ascending: false })
        .limit(10)
        .then(function (res) {
          list.innerHTML = "";
          if (res.error || !res.data || !res.data.length) {
            list.appendChild(el("div", "cx-empty", t("cx-empty")));
            return;
          }
          res.data.forEach(function (pot) { renderPotCard(pot, list, out, refresh); });
        });
    }

    createBtn.addEventListener("click", function () {
      createBtn.disabled = true;
      sb().rpc("create_pot").then(function (res) {
        createBtn.disabled = false;
        if (res.error) return showRpcError(out, res.error);
        refresh();
      });
    });

    refresh();
    openListsPollTimers.pot = setInterval(refresh, 8000);
    window.Casino._refreshCurrentList = refresh;
  }

  function renderPotCard(pot, list, out, refreshAll) {
    var card = el("div", "cx-pot-card");
    card.appendChild(el("div", "cx-pot-total", t("cx-pot-total") + ": " + fmtCents(pot.total_cents)));
    var entriesEl = el("div", "cx-entries", "…");
    card.appendChild(entriesEl);

    var joinRow = el("div", "cx-row");
    var stakeInput = el("input", "cx-input");
    stakeInput.type = "number"; stakeInput.min = "1"; stakeInput.value = "100";
    var joinBtn = el("button", "cx-toggle", t("cx-join"));
    joinRow.appendChild(stakeInput);
    joinRow.appendChild(joinBtn);
    card.appendChild(joinRow);

    var drawBtn = el("button", "cx-toggle cx-toggle-active", t("cx-pot-draw"));
    card.appendChild(drawBtn);

    sb().from("pot_entries").select("user_id, stake_cents").eq("pot_id", pot.id).then(function (res) {
      var n = (res.data || []).length;
      entriesEl.textContent = n + " " + t("cx-pot-entries");
    });

    joinBtn.addEventListener("click", function () {
      var stake = parseInt(stakeInput.value, 10);
      if (!stake || stake <= 0) return;
      joinBtn.disabled = true;
      Core.flushEarnings().then(function () {
        return sb().rpc("join_pot", { p_pot_id: pot.id, p_stake: stake });
      }).then(function (res) {
        joinBtn.disabled = false;
        if (res.error) return showRpcError(out, res.error);
        refreshAll();
      });
    });

    drawBtn.addEventListener("click", function () {
      drawBtn.disabled = true;
      sb().rpc("draw_pot", { p_pot_id: pot.id }).then(function (res) {
        drawBtn.disabled = false;
        if (res.error) return showRpcError(out, res.error);
        var winnerId = res.data;
        out.innerHTML = "";
        out.appendChild(resultBanner(winnerId === uid() ? "win" : "info",
          t("cx-pot-winner") + ": " + (winnerId === uid() ? t("cx-you") : winnerId.slice(0, 8))));
        refreshAll();
      });
    });

    list.appendChild(card);
  }

  // ============================================================ Leaderboard

  function refreshLeaderboard() {
    if (!leaderboardContainer || !sb()) return;
    leaderboardContainer.innerHTML = "";
    sb().from("profiles").select("id, username, balance_cents")
      .order("balance_cents", { ascending: false })
      .limit(10)
      .then(function (res) {
        if (res.error || !res.data) return;
        var table = el("table", "cx-table");
        res.data.forEach(function (row, i) {
          var tr = document.createElement("tr");
          if (row.id === uid()) tr.className = "cx-me";
          tr.appendChild(el("td", "", String(i + 1)));
          tr.appendChild(el("td", "", row.username || "—"));
          tr.appendChild(el("td", "cx-td-right", fmtCents(row.balance_cents)));
          table.appendChild(tr);
        });
        leaderboardContainer.appendChild(table);
      });
  }

  // ============================================================ Boot

  function boot() {
    Core = window.TypingCasinoCore;
    select = document.getElementById("casino-game-select");
    container = document.getElementById("casino-game-container");
    leaderboardContainer = document.getElementById("leaderboard-container");

    buildSelect();
    select.addEventListener("change", function () { showGame(select.value); });
    showGame(GAMES[0].id);

    var refreshLbBtn = document.getElementById("btn-refresh-leaderboard");
    if (refreshLbBtn) refreshLbBtn.addEventListener("click", refreshLeaderboard);
    refreshLeaderboard();
  }

  // taskpane.js calls these as things happen - no extra network calls of
  // our own beyond what taskpane.js already made.
  window.Casino = {
    onProfileLoaded: function () { refreshLeaderboard(); },
    onProfileRealtimeUpdate: function () { refreshLeaderboard(); },
    onTableRealtimeUpdate: function (table, payload) {
      if (window.Casino._refreshCurrentList &&
          (currentGameId === "pvp_coinflip" || currentGameId === "pvp_dice" || currentGameId === "rps" || currentGameId === "pot")) {
        window.Casino._refreshCurrentList();
      }
      if (table === "profiles") refreshLeaderboard();
    },
  };

  // Wait for both DOM and TypingCasinoCore (set up inside Office.onReady in
  // taskpane.js, which loads before this file but boots asynchronously).
  function waitAndBoot() {
    if (window.TypingCasinoCore && document.getElementById("casino-game-select")) {
      boot();
    } else {
      setTimeout(waitAndBoot, 100);
    }
  }
  waitAndBoot();
})();
