/* global document */
(function () {
  // Move focus to the error summary after a refused submission. role="alert" is
  // announced inconsistently on a full page load, so without this a screen-reader
  // user is dropped at the top of a long form with no signal it was rejected.
  // Guarded separately from the preview so a missing preview cannot disable it.
  var summary = document.querySelector(".error-summary");
  if (summary && typeof summary.focus === "function") summary.focus();
})();

(function () {
  var preview = document.querySelector("[data-signup-preview]");
  if (!preview) return;
  var form = document.querySelector("[data-signup-form]");
  if (!form) return;

  var kind = form.getAttribute("data-signup-form");
  var title = preview.querySelector("[data-preview-title]");
  var subtitle = preview.querySelector("[data-preview-subtitle]");
  var description = preview.querySelector("[data-preview-description]");
  if (!title || !subtitle) return;

  function value(name) {
    var control = form.elements.namedItem(name);
    if (!control) return "";
    if (typeof control.value === "string") return control.value.trim();
    return "";
  }

  function publicValue(slot) {
    var name = preview.getAttribute("data-preview-" + slot + "-field");
    return name ? value(name) : "";
  }

  function update() {
    if (kind === "host") {
      title.textContent = publicValue("title") || "Your porch";
      subtitle.textContent =
        publicValue("subtitle") || "Your details will appear here";
      if (description) {
        description.textContent =
          publicValue("description") ||
          "Keep filling in the form to shape this card.";
      }
      return;
    }
    title.textContent = publicValue("title") || "Your act";
    subtitle.textContent =
      publicValue("subtitle") || "Your details will appear here";
    if (description) {
      description.textContent =
        publicValue("description") ||
        "Keep filling in the form to shape this card.";
    }
  }

  form.addEventListener("input", update);
  update();
})();
