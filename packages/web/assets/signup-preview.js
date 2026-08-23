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
  var details = preview.querySelector("[data-preview-details]");
  if (!title || !subtitle || !description || !details) return;

  function value(name) {
    var control = form.elements.namedItem(name);
    if (!control) return "";
    if (typeof control.value === "string") return control.value.trim();
    return "";
  }

  function checked(name) {
    var control = form.querySelector('input[name="' + name + '"]:checked');
    return control ? control.value : "";
  }

  function update() {
    if (kind === "host") {
      title.textContent = value("venue_title") || "Your porch";
      subtitle.textContent =
        value("venue_address") || "Your details will appear here";
      description.textContent =
        value("space_description") ||
        "Keep filling in the form to shape this card.";
      details.textContent = [
        checked("has_power") === "yes" ? "Power available" : "",
        checked("rain_backup") === "yes" ? "Rain backup" : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return;
    }
    title.textContent = value("act_name") || "Your act";
    subtitle.textContent = value("genres") || "Your details will appear here";
    description.textContent =
      value("description") || "Keep filling in the form to shape this card.";
    details.textContent = [
      value("duration_minutes") ? value("duration_minutes") + " minutes" : "",
      checked("requires_amplification") === "yes" ? "Amplified" : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }

  form.addEventListener("input", update);
  update();
})();
