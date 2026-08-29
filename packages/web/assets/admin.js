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

  function sync() {
    var checked = 0;
    for (var index = 0; index < boxes.length; index += 1) {
      if (boxes[index].checked) checked += 1;
    }
    toggle.checked = checked === boxes.length;
    toggle.indeterminate = checked > 0 && checked < boxes.length;
  }

  toggle.addEventListener("change", function () {
    for (var index = 0; index < boxes.length; index += 1) {
      boxes[index].checked = toggle.checked;
    }
    toggle.indeterminate = false;
  });

  // Without this the master box keeps claiming "every unsent message" after one
  // is unticked, which misdescribes what pressing send would do.
  for (var index = 0; index < boxes.length; index += 1) {
    boxes[index].addEventListener("change", sync);
  }
})();
