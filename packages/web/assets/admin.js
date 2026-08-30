/* global document, navigator */
// Select-all for the outbox review list.
//
// KTD3: this is a convenience, never a requirement. Every control it touches
// works on its own, and the script returns before touching anything when its
// container is absent - which is every admin page except the wave review list.
(function () {
  "use strict";

  var form = document.getElementById("outbox-selection");
  if (!form) return;

  var toggle = form.querySelector('input[name="select_all"]');
  var boxes = form.querySelectorAll('input[name="message"]');

  function sync() {
    var checked = 0;
    for (var index = 0; index < boxes.length; index += 1) {
      if (boxes[index].checked) checked += 1;
    }
    toggle.checked = checked === boxes.length;
    toggle.indeterminate = checked > 0 && checked < boxes.length;
  }

  if (toggle && boxes.length > 0) {
    toggle.addEventListener("change", function () {
      for (var index = 0; index < boxes.length; index += 1) {
        boxes[index].checked = toggle.checked;
      }
      toggle.indeterminate = false;
    });

    // Without this the master box keeps claiming "every unsent message" after
    // one is unticked, which misdescribes what the selection contains.
    for (var index = 0; index < boxes.length; index += 1) {
      boxes[index].addEventListener("change", sync);
    }
  }

  var copyAction = form.querySelector("[data-outbox-copy]");
  var copyStatus = form.querySelector("[data-outbox-copy-status]");
  if (!copyAction || !copyStatus) return;
  var copyFailure =
    "Could not copy the selected messages. Review and copy each message instead.";
  var copyPending = false;

  copyAction.addEventListener("click", async function (event) {
    event.preventDefault();
    if (copyPending) return;
    var selected = form.querySelectorAll('input[name="message"]:checked');
    if (selected.length === 0) {
      copyStatus.textContent = "Select at least one message to copy.";
      return;
    }

    var rendered = [];
    for (var index = 0; index < selected.length; index += 1) {
      var subjectId = selected[index].getAttribute("data-copy-subject");
      var bodyId = selected[index].getAttribute("data-copy-body");
      var subject = subjectId ? document.getElementById(subjectId) : null;
      var body = bodyId ? document.getElementById(bodyId) : null;
      if (subject && body) {
        rendered.push(
          "Subject: " +
            subject.textContent.trim() +
            "\n\n" +
            body.textContent.trim(),
        );
      }
    }

    if (
      rendered.length !== selected.length ||
      !navigator.clipboard ||
      typeof navigator.clipboard.writeText !== "function"
    ) {
      copyStatus.textContent = copyFailure;
      return;
    }

    var wasDisabled = copyAction.disabled;
    copyPending = true;
    copyAction.disabled = true;
    try {
      await navigator.clipboard.writeText(
        rendered.join("\n\n----- next message -----\n\n"),
      );
      copyStatus.textContent =
        "Copied " +
        selected.length +
        (selected.length === 1 ? " message." : " messages.");
    } catch {
      copyStatus.textContent = copyFailure;
    } finally {
      copyAction.disabled = wasDisabled;
      copyPending = false;
    }
  });
})();
