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
      "setup-intro": "Connect this add-in to your Supabase project once (ask your administrator for these values).",
      "label-url": "Supabase URL",
      "label-key": "Supabase anon key",
      "btn-save": "Save",
      "btn-settings": "Settings",
      "btn-hide-settings": "Hide settings",
      "alert-fill-fields": "Please fill in both fields.",
    },
    he: {
      "app-title": "קזינו ההקלדה",
      "letters-label": "אותיות שנצברו",
      "words-label": "מילים תקינות",
      "skipped-misspelled": "לא נספרו (שגיאת כתיב)",
      "skipped-pasted": "לא נספרו (הודבקו)",
      "conn-on": "מחובר",
      "conn-off": "לא מחובר",
      "setup-intro": "חברו את התוסף לפרויקט ה-Supabase שלכם (יש לקבל את הפרטים הבאים ממנהל המערכת).",
      "label-url": "כתובת Supabase (URL)",
      "label-key": "מפתח anon של Supabase",
      "btn-save": "שמירה",
      "btn-settings": "הגדרות",
      "btn-hide-settings": "הסתרת הגדרות",
      "alert-fill-fields": "יש למלא את שני השדות.",
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
      "txt-setup-intro": "setup-intro",
      "txt-label-url": "label-url",
      "txt-label-key": "label-key",
    };

    Object.keys(map).forEach(function (elId) {
      var el = document.getElementById(elId);
      if (el) el.textContent = t(map[elId]);
    });

    var saveBtn = document.getElementById("btn-save-setup");
    if (saveBtn) saveBtn.textContent = t("btn-save");

    var settingsBtn = document.getElementById("btn-open-setup");
    if (settingsBtn) settingsBtn.textContent = t("btn-settings");
  }

  // Exposed globally for taskpane.js
  window.I18N = {
    lang: lang,
    dir: dir,
    t: t,
    applyStaticText: applyStaticText,
  };
})();
