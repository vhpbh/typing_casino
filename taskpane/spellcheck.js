/*
 * spellcheck.js
 *
 * IMPORTANT PLATFORM NOTE:
 * Office.js does not expose Word's own proofing engine (the thing that draws
 * the red squiggly underline) to add-ins - there is no API that returns
 * "is this range flagged as misspelled". So this add-in ships its own
 * offline spell-checkers instead and treats a word as "correct" when either
 * one recognizes it.
 *
 * ENGLISH: a real Hunspell engine (nspell) with the same dictionary
 * LibreOffice/Firefox use - full support for prefixes/suffixes/conjugations.
 *
 * HEBREW: NOT the equivalent Hunspell engine - it was tried first and
 * dropped. The Hebrew Hunspell dictionary encodes its huge set of proclitic
 * combinations (ו/ה/ב/כ/ל/מ/ש - "and/the/in/like/to/from/that", which
 * attach directly onto almost every noun) as Hunspell affix rules, and
 * expanding all of that combinatorially made nspell hang indefinitely while
 * building the dictionary (confirmed: still hadn't finished after 90+
 * seconds testing it directly, versus ~200ms for English) - which is what
 * caused every single word to read as misspelled: the English dictionary
 * finished loading fast, "ready" flipped true, and every Hebrew word failed
 * the (English) check while Hebrew was still stuck mid-build.
 *
 * Instead, Hebrew uses a flat list of ~340,000 real dictionary word forms
 * (extracted once from that same Hunspell dictionary's word list, with no
 * affix expansion - see he-words.txt) plus a small hand-written check that
 * strips up to 3 leading proclitic letters (the ones listed above) before
 * giving up on a word. This is NOT full Hunspell-equivalent morphological
 * analysis - some valid inflected forms it doesn't already know about, or
 * unusual proclitic stacking, can still be missed - but it's fast, never
 * hangs, and covers the overwhelming majority of real usage.
 */
(function () {
  "use strict";

  var enSpeller = null;
  var heWordSet = null;
  var ready = false; // true once at least one language is usable
  var lastError = null;
  var statusListeners = [];
  var RETRY_MS = [1000, 2000, 4000, 8000, 15000]; // then repeats at 15s
  var HE_PROCLITICS = "ושהבכלמ"; // ו ש ה ב כ ל מ

  function notify() {
    statusListeners.forEach(function (fn) {
      try { fn({ ready: ready, error: lastError }); } catch (e) { /* listener's problem */ }
    });
  }

  function fetchOrThrow(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " for " + url);
      return r;
    });
  }

  function loadEnglish() {
    return Promise.all([
      fetchOrThrow("dict/en.aff").then(function (r) { return r.arrayBuffer(); }),
      fetchOrThrow("dict/en.dic").then(function (r) { return r.arrayBuffer(); }),
    ]).then(function (buffers) {
      enSpeller = window.nspell({ aff: new Uint8Array(buffers[0]), dic: new Uint8Array(buffers[1]) });
      ready = true;
      lastError = null;
      notify();
    });
  }

  function loadHebrew() {
    return fetchOrThrow("dict/he-words.txt")
      .then(function (r) { return r.text(); })
      .then(function (text) {
        heWordSet = new Set(text.split("\n").filter(Boolean));
        ready = true;
        lastError = null;
        notify();
      });
  }

  function loadWithRetry(name, loaderFn, attempt) {
    attempt = attempt || 0;
    loaderFn().catch(function (err) {
      console.error("Typing Casino: failed to load '" + name + "' dictionary", err);
      lastError = "dict-" + name + ": " + err.message;
      notify();
      var delay = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
      setTimeout(function () { loadWithRetry(name, loaderFn, attempt + 1); }, delay);
    });
  }

  function init() {
    loadWithRetry("en", loadEnglish);
    loadWithRetry("he", loadHebrew);
  }

  function isValidHebrewWord(word) {
    if (!heWordSet) return false;
    if (heWordSet.has(word)) return true;
    for (var i = 1; i <= 3 && i < word.length; i++) {
      var isAllProclitic = true;
      for (var j = 0; j < i; j++) {
        if (HE_PROCLITICS.indexOf(word[j]) === -1) { isAllProclitic = false; break; }
      }
      if (isAllProclitic && heWordSet.has(word.slice(i))) return true;
    }
    return false;
  }

  // A "word" for counting purposes: letters only (Latin or Hebrew), length >= 1.
  // Punctuation-only tokens, numbers, and single stray characters glued to
  // punctuation are stripped before this is called.
  function isValidCompleteWord(word) {
    if (!ready || !word) return false;
    var clean = word.trim();
    if (!clean) return false;
    if (enSpeller && enSpeller.correct(clean)) return true;
    if (isValidHebrewWord(clean)) return true;
    return false;
  }

  window.Spellcheck = {
    init: init,
    isReady: function () { return ready; },
    isValidCompleteWord: isValidCompleteWord,
    getLastError: function () { return lastError; },
    onStatusChange: function (fn) { statusListeners.push(fn); },
  };
})();
