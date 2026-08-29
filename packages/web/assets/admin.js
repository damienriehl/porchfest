/* global document */
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
  if (!toggle || boxes.length === 0) return;

  toggle.addEventListener("change", function () {
    for (var index = 0; index < boxes.length; index += 1) {
      boxes[index].checked = toggle.checked;
    }
  });
})();
