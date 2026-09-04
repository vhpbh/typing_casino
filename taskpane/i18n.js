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
