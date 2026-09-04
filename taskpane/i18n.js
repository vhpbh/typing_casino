/*
 * i18n.js
 * Detects the user's / Office's display language and applies English or
 * Hebrew strings + text direction (LTR/RTL) to the taskpane.
 *
 * Detection order:
 *   1. Office.context.displayLanguage (the language Office itself is running in)
 *   2. navigator.language (browser/OS fallback, e.g. when testing outside Office)
 *   3. "en" as a final fallback
 */
(function () {
  "use strict";

  var STRINGS = {
    en: {
      "app-title": "Typing Casino",
      "letters-label": "letters earned",
      "words-label": "valid words",
      "skipped-misspelled": "skipped (misspelled)",
      "skipped-pasted": "skipped (pasted)",
      "conn-on": "connected",
      "conn-off": "not connected",
      "btn-save": "Save",
      "waiting-text": "Server is full right now (200 players connected) — waiting for a spot to free up…",
      "label-name": "Your name in the game",
      "name-placeholder": "Player",
      "name-saved": "Saved!",
      "balance-label": "Your balance",
      "casino-title": "Casino",
      "leaderboard-title": "Leaderboard",

      "cx-stake": "Stake ($)",
      "cx-play": "Play",
      "cx-insufficient": "Not enough balance for that.",
      "cx-error": "Something went wrong.",
      "cx-rate-limited": "Slow down a little and try again.",
      "cx-win": "You won!",
      "cx-lose": "You lost",
      "cx-push": "Push — refunded",
      "cx-you": "(you)",
      "cx-empty": "Nothing open right now.",
      "cx-create": "Create",
      "cx-join": "Join",
      "cx-cancel": "Cancel",
      "cx-reveal": "Reveal",
      "cx-open-bets": "Open bets",

      "cx-game-wheel": "🎡 Wheel of Fortune",
      "cx-game-coinflip": "🪙 Coinflip (vs house)",
      "cx-game-dice": "🎲 Dice (vs house)",
      "cx-game-slots": "🎰 Slots",
      "cx-game-crash": "📈 Crash",
      "cx-game-hilo": "🂡 Hi-Lo",
      "cx-game-pvp-coinflip": "🤝 1v1 Coinflip",
      "cx-game-pvp-dice": "🤝 Dice Duel",
      "cx-game-rps": "✊✋✌️ Rock-Paper-Scissors",
      "cx-game-pot": "🎟️ Group Pot",

      "cx-wheel-spin": "Spin",
      "cx-seg-bust": "BUST",
      "cx-seg-jackpot": "JACKPOT!",

      "cx-heads": "Heads",
      "cx-tails": "Tails",

      "cx-roll-under": "Win if roll is under",
      "cx-roll-result": "Rolled",

      "cx-cashout-at": "Cash out at ×",
      "cx-crash-point": "Crashed at ×",

      "cx-hilo-start": "Draw card",
      "cx-hilo-card": "Card",
      "cx-higher": "Higher",
      "cx-lower": "Lower",
      "cx-hilo-outcome-win": "Win!",
      "cx-hilo-outcome-push": "Push",
      "cx-hilo-outcome-lose": "Lose",

      "cx-rps-rock": "Rock",
      "cx-rps-paper": "Paper",
      "cx-rps-scissors": "Scissors",
      "cx-rps-remember": "After someone joins, come back here to reveal your move and finish the round — your stake stays locked until you do.",
      "cx-rps-waiting-reveal": "Waiting on reveal",

      "cx-pot-create": "Start a new pot",
      "cx-pot-total": "Pot total",
      "cx-pot-entries": "players",
      "cx-pot-draw": "Draw winner",
      "cx-pot-winner": "Winner",
    },
    he: {
      "app-title": "קזינו ההקלדה",
      "letters-label": "אותיות שנצברו",
      "words-label": "מילים תקינות",
      "skipped-misspelled": "לא נספרו (שגיאת כתיב)",
      "skipped-pasted": "לא נספרו (הודבקו)",
      "conn-on": "מחובר",
      "conn-off": "לא מחובר",
      "btn-save": "שמירה",
      "waiting-text": "השרת מלא כרגע (200 שחקנים מחוברים) — ממתינים לפינוי מקום…",
      "label-name": "השם שלך במשחק",
      "name-placeholder": "שחקן",
      "name-saved": "נשמר!",
      "balance-label": "היתרה שלך",
      "casino-title": "קזינו",
      "leaderboard-title": "טבלת מובילים",

      "cx-stake": "הימור (בסנטים)",
      "cx-play": "שחק",
      "cx-insufficient": "אין מספיק יתרה להימור הזה.",
      "cx-error": "משהו השתבש.",
      "cx-rate-limited": "רגע, לאט קצת - ונסה שוב.",
      "cx-win": "ניצחת!",
      "cx-lose": "הפסדת",
      "cx-push": "תיקו - הכסף הוחזר",
      "cx-you": "(אתה)",
      "cx-empty": "אין כרגע שום דבר פתוח.",
      "cx-create": "צור",
      "cx-join": "הצטרף",
      "cx-cancel": "בטל",
      "cx-reveal": "חשוף מהלך",
      "cx-open-bets": "הימורים פתוחים",

      "cx-game-wheel": "🎡 גלגל המזל",
      "cx-game-coinflip": "🪙 הטלת מטבע (מול הבית)",
      "cx-game-dice": "🎲 קוביות (מול הבית)",
      "cx-game-slots": "🎰 מכונת מזל",
      "cx-game-crash": "📈 קראש",
      "cx-game-hilo": "🂡 גבוה-נמוך",
      "cx-game-pvp-coinflip": "🤝 הטלת מטבע 1 מול 1",
      "cx-game-pvp-dice": "🤝 קרב קוביות",
      "cx-game-rps": "✊✋✌️ אבן-נייר-מספריים",
      "cx-game-pot": "🎟️ קופה קבוצתית",

      "cx-wheel-spin": "סובב",
      "cx-seg-bust": "הפסד",
      "cx-seg-jackpot": "ג'קפוט!",

      "cx-heads": "עץ",
      "cx-tails": "פלי",

      "cx-roll-under": "מנצח אם התוצאה מתחת ל",
      "cx-roll-result": "התוצאה",

      "cx-cashout-at": "פדיון בכפולה ×",
      "cx-crash-point": "התרסק בכפולה ×",

      "cx-hilo-start": "משוך קלף",
      "cx-hilo-card": "קלף",
      "cx-higher": "גבוה יותר",
      "cx-lower": "נמוך יותר",
      "cx-hilo-outcome-win": "ניצחון!",
      "cx-hilo-outcome-push": "תיקו",
      "cx-hilo-outcome-lose": "הפסד",

      "cx-rps-rock": "אבן",
      "cx-rps-paper": "נייר",
      "cx-rps-scissors": "מספריים",
      "cx-rps-remember": "אחרי שמישהו יצטרף, יש לחזור לכאן כדי לחשוף את המהלך שלך ולסיים את הסיבוב - הכסף שלך יישאר נעול עד אז.",
      "cx-rps-waiting-reveal": "ממתין לחשיפה",

      "cx-pot-create": "פתח קופה חדשה",
      "cx-pot-total": "סך הקופה",
      "cx-pot-entries": "משתתפים",
      "cx-pot-draw": "הגרל זוכה",
      "cx-pot-winner": "הזוכה",
    },
  };

  function detectLang() {
    try {
      if (typeof Office !== "undefined" && Office.context && Office.context.displayLanguage) {
        if (Office.context.displayLanguage.toLowerCase().indexOf("he") === 0) return "he";
        return "en";
      }
    } catch (e) { /* Office not ready yet, fall through */ }

    var nav = (navigator.language || navigator.userLanguage || "en").toLowerCase();
    return nav.indexOf("he") === 0 ? "he" : "en";
  }

  var lang = detectLang();
  var dict = STRINGS[lang] || STRINGS.en;
  var dir = lang === "he" ? "rtl" : "ltr";

  function t(key) {
    return dict[key] || STRINGS.en[key] || key;
  }

  function applyStaticText() {
    document.documentElement.lang = lang;
    document.body.setAttribute("dir", dir);

    var map = {
      "txt-title": "app-title",
      "txt-letters-label": "letters-label",
      "txt-words-label": "words-label",
      "txt-skipped-misspelled": "skipped-misspelled",
      "txt-skipped-pasted": "skipped-pasted",
      "txt-waiting": "waiting-text",
      "txt-label-name": "label-name",
      "txt-balance-label": "balance-label",
      "txt-casino-title": "casino-title",
      "txt-leaderboard-title": "leaderboard-title",
    };

    Object.keys(map).forEach(function (elId) {
      var el = document.getElementById(elId);
      if (el) el.textContent = t(map[elId]);
    });

    var saveNameBtn = document.getElementById("btn-save-name");
    if (saveNameBtn) saveNameBtn.textContent = t("btn-save");

    var nameInput = document.getElementById("input-name");
    if (nameInput) nameInput.placeholder = t("name-placeholder");
  }

  // Exposed globally for taskpane.js
  window.I18N = {
    lang: lang,
    dir: dir,
    t: t,
    applyStaticText: applyStaticText,
  };
})();
