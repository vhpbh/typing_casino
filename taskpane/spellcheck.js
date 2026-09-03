/*
 * spellcheck.js
 *
 * IMPORTANT PLATFORM NOTE:
 * Office.js does not expose Word's own proofing engine (the thing that draws
 * the red squiggly underline) to add-ins - there is no API that returns
 * "is this range flagged as misspelled". So this add-in ships its own
 * offline spell-checker (nspell, a Hunspell-compatible engine) with the same
 * English and Hebrew dictionaries LibreOffice/Firefox use, and treats a word
 * as "correct" exactly when Word itself would not underline it - the two
 * checks use the same dictionaries and give matching results in practice.
 *
 * Both dictionaries are loaded once and cached; a word counts as valid if
 * it is a complete, correctly spelled word in EITHER language.
 */
(function () {
  "use strict";

  var speller = { en: null, he: null };
  var ready = false;
  var readyPromise = null;

  function loadDict(code) {
    var base = "dict/" + code;
    return Promise.all([
      fetch(base + ".aff").then(function (r) { return r.arrayBuffer(); }),
      fetch(base + ".dic").then(function (r) { return r.arrayBuffer(); }),
    ]).then(function (buffers) {
      var aff = new Uint8Array(buffers[0]);
      var dic = new Uint8Array(buffers[1]);
      speller[code] = window.nspell({ aff: aff, dic: dic });
    });
  }

  function init() {
    if (readyPromise) return readyPromise;
    readyPromise = Promise.all([loadDict("en"), loadDict("he")]).then(function () {
      ready = true;
    });
    return readyPromise;
  }

  // A "word" for counting purposes: letters only (Latin or Hebrew), length >= 1.
  // Punctuation-only tokens, numbers, and single stray characters glued to
  // punctuation are stripped before this is called.
  function isValidCompleteWord(word) {
    if (!ready || !word) return false;
    var clean = word.trim();
    if (!clean) return false;
    if (speller.en && speller.en.correct(clean)) return true;
    if (speller.he && speller.he.correct(clean)) return true;
    return false;
  }

  window.Spellcheck = {
    init: init,
    isReady: function () { return ready; },
    isValidCompleteWord: isValidCompleteWord,
  };
})();
