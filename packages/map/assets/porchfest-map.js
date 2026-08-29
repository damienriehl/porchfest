/* global document, L, window */
// Accessible interactive map and lineup for SAP Porchfest 2026.
(function () {
  "use strict";

  var scriptElement = document.currentScript;
  var DATA_URL =
    (scriptElement && scriptElement.getAttribute("data-map-url")) ||
    window.PORCHFEST_MAP_DATA_URL ||
    "/data/venues-2026.json";
  var DATA_TIMEOUT_MS = 10000;
  var TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  var ALL_FILTERS = {};
  var TILE_ATTRIBUTION =
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  var map = null;
  var markersByVenueKey = Object.create(null);
  var pendingCardPopupHandler = null;
  var venueLayoutAnimationFrameId = null;
  var venueLayoutResizeTimeoutId = null;
  var viewState = {
    hour: ALL_FILTERS,
    genre: ALL_FILTERS,
    sortDirection: "asc",
  };

  function cleanText(value) {
    if (value === null || value === undefined) return "";
    return String(value).trim();
  }

  function normalizedWhitespace(value) {
    return cleanText(value).replace(/\s+/g, " ");
  }

  function venueKey(venue) {
    return JSON.stringify([
      cleanText(venue && venue.title),
      venue && venue.lat,
      venue && venue.lng,
    ]);
  }

  function appendTextElement(parent, tagName, className, value) {
    var text = cleanText(value);
    if (!text) return null;

    var element = document.createElement(tagName);
    if (className) element.className = className;
    element.textContent = text;
    parent.appendChild(element);
    return element;
  }

  function appendLabelledText(parent, className, label, value) {
    var text = cleanText(value);
    if (!text) return null;

    var paragraph = document.createElement("p");
    paragraph.className = className;

    var strong = document.createElement("strong");
    strong.textContent = label;
    paragraph.appendChild(strong);
    paragraph.appendChild(document.createTextNode(" " + text));
    parent.appendChild(paragraph);
    return paragraph;
  }

  function externalLinkDetails(link) {
    var label = cleanText(link && link.label) || "Visit link";
    try {
      var text = cleanText(link && link.url);
      if (!text) return null;
      var url = new URL(text, window.location.href);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;

      var hostname = cleanText(url.hostname).replace(/^www\./i, "");
      return {
        label: label,
        url: url.href,
        visibleText: hostname || label,
      };
    } catch {
      return null;
    }
  }

  function appendLinks(parent, links) {
    if (!Array.isArray(links)) return;

    var safeLinks = links.map(externalLinkDetails).filter(function (link) {
      return link;
    });

    if (!safeLinks.length) return;

    var list = document.createElement("ul");
    list.className = "porchfest-act-links";
    safeLinks.forEach(function (link) {
      var item = document.createElement("li");
      var anchor = document.createElement("a");
      anchor.href = link.url;
      anchor.target = "_blank";
      anchor.rel = "noopener";
      anchor.textContent = link.visibleText;
      var accessibleLabel = link.label;
      if (link.visibleText !== link.label) {
        accessibleLabel += " — " + link.visibleText;
      }
      anchor.setAttribute("aria-label", accessibleLabel);
      anchor.setAttribute("title", accessibleLabel);
      item.appendChild(anchor);
      list.appendChild(item);
    });
    parent.appendChild(list);
  }

  function createActContent(act, headingLevel) {
    var item = document.createElement("li");
    item.className = "porchfest-act";

    appendTextElement(
      item,
      "p",
      "porchfest-act-slot",
      cleanText(act && act.slot_label) || "Time to be announced",
    );
    appendTextElement(
      item,
      headingLevel,
      "porchfest-act-name",
      cleanText(act && act.name) || "Performer to be announced",
    );
    appendLabelledText(item, "porchfest-act-genre", "Genre:", act && act.genre);
    appendTextElement(
      item,
      "p",
      "porchfest-act-description",
      act && act.description,
    );
    appendLinks(item, act && act.links);
    appendLabelledText(item, "porchfest-act-note", "Note:", act && act.note);

    return item;
  }

  function venueActs(venue) {
    return Array.isArray(venue && venue.acts) ? venue.acts : [];
  }

  function genreTags(act) {
    return cleanText(act && act.genre)
      .split(",")
      .map(function (genre) {
        return genre.trim();
      })
      .filter(function (genre) {
        return genre;
      });
  }

  function timeInSeconds(value) {
    var match =
      typeof value === "string" &&
      /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|([+-])(\d{2})(?::?(\d{2}))?)?$/i.exec(
        value,
      );
    var seconds;
    var offset;
    if (!match) return null;

    seconds =
      Number(match[1]) * 3600 +
      Number(match[2]) * 60 +
      Number(match[3]) +
      Number("0." + (match[4] || "0"));
    if (match[5]) {
      offset = Number(match[6]) * 3600 + Number(match[7] || "0") * 60;
      seconds += match[5] === "+" ? -offset : offset;
    }
    return seconds;
  }

  function actInterval(act) {
    var start = timeInSeconds(act && act.slot_start);
    var end = timeInSeconds(act && act.slot_end);
    if (start === null || end === null || start >= end) return null;
    return { start: start, end: end };
  }

  function hourIntervals(venues, hour) {
    var intervals = [];
    venues.forEach(function (venue) {
      venueActs(venue).forEach(function (act) {
        var interval;
        if (act && act.slot_label === hour) {
          interval = actInterval(act);
          if (interval) intervals.push(interval);
        }
      });
    });
    return intervals;
  }

  function actMatchesHour(act, hour, selectedIntervals) {
    var interval;
    if (hour === ALL_FILTERS) return true;
    if (act && act.slot_label === hour) return true;

    interval = actInterval(act);
    if (!interval) return false;
    return selectedIntervals.some(function (selectedInterval) {
      return (
        interval.start < selectedInterval.end &&
        selectedInterval.start < interval.end
      );
    });
  }

  function venueMatchesHour(venue, hour, selectedIntervals) {
    return venueActs(venue).some(function (act) {
      return actMatchesHour(act, hour, selectedIntervals);
    });
  }

  function venueMatchesGenre(venue, genre) {
    var acts = venueActs(venue);
    if (genre === ALL_FILTERS) return true;
    return acts.some(function (act) {
      return genreTags(act).indexOf(genre) !== -1;
    });
  }

  function venueMatchesView(venue, hour, genre, selectedIntervals) {
    return (
      venueMatchesGenre(venue, genre) &&
      venueMatchesHour(venue, hour, selectedIntervals)
    );
  }

  function applyCardViewClasses(node, matches) {
    if (!node) return;
    node.classList.toggle("is-match", matches === true);
    node.classList.toggle("is-collapsed", matches === false);
  }

  function applyMarkerViewClasses(node, matches) {
    if (!node) return;
    node.classList.toggle("is-match", matches === true);
    node.classList.toggle("is-dimmed", matches === false);
  }

  function showNoMatches(status) {
    status.hidden = false;
    status.className = "porchfest-map-status is-no-match";
    status.textContent =
      "No venues match these filters. Choose All for hour and genre to see the full lineup.";
  }

  function applyView(status, listSection, venues, markerLookup) {
    var hour = viewState.hour;
    var genre = viewState.genre;
    var selectedIntervals =
      hour === ALL_FILTERS ? [] : hourIntervals(venues, hour);
    var hasActiveFilter = hour !== ALL_FILTERS || genre !== ALL_FILTERS;
    var matchedVenueCount = 0;
    var cardsByVenueKey = Object.create(null);
    var matchesByVenueKey = Object.create(null);

    listSection
      .querySelectorAll(".porchfest-venue-card")
      .forEach(function (card) {
        cardsByVenueKey[card.dataset.venueKey] = card;
      });

    venues.forEach(function (venue) {
      var key = venueKey(venue);
      var matches = hasActiveFilter
        ? venueMatchesView(venue, hour, genre, selectedIntervals)
        : null;
      matchesByVenueKey[key] = matches;
      if (matches === true) matchedVenueCount += 1;
    });

    var hasNoMatches = hasActiveFilter && matchedVenueCount === 0;
    venues.forEach(function (venue) {
      var key = venueKey(venue);
      var marker = markerLookup[key];
      var matches = matchesByVenueKey[key];
      applyCardViewClasses(cardsByVenueKey[key], matches);
      applyMarkerViewClasses(marker && marker.getElement(), matches);
    });

    if (hasNoMatches) {
      showNoMatches(status);
      return;
    }

    status.hidden = true;
    status.className = "porchfest-map-status";
  }

  function updatePressedButtons(group, activeValue) {
    group.querySelectorAll("button").forEach(function (button) {
      button.setAttribute(
        "aria-pressed",
        String(button.porchfestFilterValue === activeValue),
      );
    });
  }

  function createFilterButton(
    label,
    accessibleName,
    value,
    activeValue,
    onActivate,
  ) {
    var button = document.createElement("button");
    button.className = "porchfest-filter-chip";
    button.setAttribute("type", "button");
    button.setAttribute("aria-label", accessibleName);
    button.setAttribute("aria-pressed", String(value === activeValue));
    button.porchfestFilterValue = value;
    button.dataset.filterValue = typeof value === "string" ? value : "";
    button.textContent = label;
    button.addEventListener("click", onActivate);
    return button;
  }

  function createHourControl(status, listSection, venues, markerLookup) {
    var hourControl = document.createElement("div");
    var optionsByLabel = new Map();
    hourControl.className = "porchfest-hour-control";
    hourControl.setAttribute("role", "group");
    hourControl.setAttribute("aria-label", "Filter venues by performance hour");

    venues.forEach(function (venue) {
      venueActs(venue).forEach(function (act) {
        var label = act && act.slot_label;
        var start = timeInSeconds(act && act.slot_start);
        var existing;
        if (typeof label !== "string" || label.length === 0) return;
        existing = optionsByLabel.get(label);
        if (
          !existing ||
          (start !== null &&
            (existing.start === null || start < existing.start))
        ) {
          optionsByLabel.set(label, {
            label: cleanText(label),
            name: "Show performances for " + cleanText(label),
            value: label,
            start: start,
          });
        }
      });
    });

    [{ label: "All", name: "Show all performance hours", value: ALL_FILTERS }]
      .concat(
        Array.from(optionsByLabel.values()).sort(function (left, right) {
          if (left.start !== null && right.start !== null) {
            return (
              left.start - right.start ||
              left.value.localeCompare(right.value, undefined, {
                numeric: true,
              })
            );
          }
          if (left.start !== null) return -1;
          if (right.start !== null) return 1;
          return left.value.localeCompare(right.value, undefined, {
            numeric: true,
          });
        }),
      )
      .forEach(function (option) {
        hourControl.appendChild(
          createFilterButton(
            option.label,
            option.name,
            option.value,
            viewState.hour,
            function () {
              viewState.hour = option.value;
              updatePressedButtons(hourControl, viewState.hour);
              applyView(status, listSection, venues, markerLookup);
              scheduleVenueLayout(listSection);
            },
          ),
        );
      });

    return hourControl;
  }

  function genresByFrequency(venues) {
    var counts = Object.create(null);

    venues.forEach(function (venue) {
      venueActs(venue).forEach(function (act) {
        genreTags(act).forEach(function (genre) {
          counts[genre] = (counts[genre] || 0) + 1;
        });
      });
    });

    return Object.keys(counts).sort(function (left, right) {
      return counts[right] - counts[left] || left.localeCompare(right);
    });
  }

  function createGenreFacet(status, listSection, venues, markerLookup) {
    var facet = document.createElement("details");
    facet.className = "porchfest-genre-facet accordion-item";

    var summary = document.createElement("summary");
    summary.className = "porchfest-genre-summary accordion-item-header";
    summary.textContent = "Filter by genre";
    facet.appendChild(summary);

    var content = document.createElement("div");
    content.className = "porchfest-genre-content accordion-item-content";

    var chips = document.createElement("div");
    chips.className = "porchfest-genre-chips";
    chips.setAttribute("role", "group");
    chips.setAttribute("aria-label", "Filter venues by genre");

    [{ label: "All", name: "Show all genres", value: ALL_FILTERS }]
      .concat(
        genresByFrequency(venues).map(function (genre) {
          return {
            label: genre,
            name: "Show " + genre + " performances",
            value: genre,
          };
        }),
      )
      .forEach(function (option) {
        chips.appendChild(
          createFilterButton(
            option.label,
            option.name,
            option.value,
            viewState.genre,
            function () {
              viewState.genre = option.value;
              updatePressedButtons(chips, viewState.genre);
              applyView(status, listSection, venues, markerLookup);
              scheduleVenueLayout(listSection);
            },
          ),
        );
      });

    content.appendChild(chips);
    facet.appendChild(content);
    return facet;
  }

  function sortVenueCards(listSection, venues, direction) {
    var list = listSection.querySelector(".porchfest-venue-list-items");
    var cardsByVenueKey = Object.create(null);

    list.querySelectorAll(".porchfest-venue-card").forEach(function (card) {
      cardsByVenueKey[card.dataset.venueKey] = card;
    });

    venues
      .slice()
      .sort(function (left, right) {
        var latitudeDifference = left.lat - right.lat;
        return direction === "desc" ? -latitudeDifference : latitudeDifference;
      })
      .forEach(function (venue) {
        list.appendChild(cardsByVenueKey[venueKey(venue)]);
      });
  }

  function clearVenueLayout(list) {
    list.style.removeProperty("position");
    list.style.removeProperty("height");
    list.querySelectorAll(".porchfest-venue-card").forEach(function (card) {
      card.style.removeProperty("position");
      card.style.removeProperty("width");
      card.style.removeProperty("left");
      card.style.removeProperty("top");
    });
  }

  function usesSingleVenueColumn() {
    if (window.matchMedia)
      return window.matchMedia("(max-width: 768px)").matches;
    return Number(window.innerWidth) <= 768;
  }

  function layoutVenueCards(listSection) {
    var list = listSection.querySelector(".porchfest-venue-list-items");
    var cards = list.querySelectorAll(".porchfest-venue-card");
    var listWidth;
    var gap;
    var columnWidth;
    var columnHeights;

    clearVenueLayout(list);
    if (usesSingleVenueColumn() || cards.length === 0) return;

    listWidth = Number(list.clientWidth) || 0;
    gap = parseFloat(window.getComputedStyle(list).columnGap) || 0;
    columnWidth = Math.max(0, (listWidth - gap) / 2);
    columnHeights = [0, 0];
    list.style.position = "relative";

    cards.forEach(function (card) {
      var column = columnHeights[0] <= columnHeights[1] ? 0 : 1;
      card.style.position = "absolute";
      card.style.width = columnWidth + "px";
      card.style.left = column * (columnWidth + gap) + "px";
      card.style.top = columnHeights[column] + "px";
      columnHeights[column] += (Number(card.offsetHeight) || 0) + gap;
    });

    list.style.height =
      Math.max(0, Math.max.apply(Math, columnHeights) - gap) + "px";
  }

  function scheduleVenueLayout(listSection) {
    if (venueLayoutAnimationFrameId !== null) return;

    venueLayoutAnimationFrameId = window.requestAnimationFrame(function () {
      venueLayoutAnimationFrameId = null;
      layoutVenueCards(listSection);
    });
  }

  function watchVenueLayout(listSection) {
    var list = listSection.querySelector(".porchfest-venue-list-items");

    window.addEventListener("resize", function () {
      if (venueLayoutResizeTimeoutId !== null) {
        window.clearTimeout(venueLayoutResizeTimeoutId);
      }
      venueLayoutResizeTimeoutId = window.setTimeout(function () {
        venueLayoutResizeTimeoutId = null;
        scheduleVenueLayout(listSection);
      }, 150);
    });
    list.addEventListener("focusin", function () {
      scheduleVenueLayout(listSection);
    });
    list.addEventListener("focusout", function () {
      scheduleVenueLayout(listSection);
    });
    list.addEventListener("transitionend", function (event) {
      if (event.propertyName === "max-height") {
        scheduleVenueLayout(listSection);
      }
    });
    scheduleVenueLayout(listSection);
  }

  function updateSortButton(button) {
    var isSouthToNorth = viewState.sortDirection === "asc";
    button.setAttribute("aria-pressed", String(isSouthToNorth));
    button.setAttribute(
      "aria-label",
      isSouthToNorth
        ? "Lineup sorted south to north. Sort north to south"
        : "Lineup sorted north to south. Sort south to north",
    );
    button.textContent = isSouthToNorth ? "South → north" : "North → south";
  }

  function createSortButton(listSection, venues) {
    var button = document.createElement("button");
    button.className = "porchfest-filter-chip porchfest-sort-button";
    button.setAttribute("type", "button");
    updateSortButton(button);
    button.addEventListener("click", function () {
      viewState.sortDirection =
        viewState.sortDirection === "asc" ? "desc" : "asc";
      sortVenueCards(listSection, venues, viewState.sortDirection);
      updateSortButton(button);
      scheduleVenueLayout(listSection);
    });
    return button;
  }

  function renderMapControls(
    mapElement,
    status,
    listSection,
    venues,
    markerLookup,
  ) {
    var controls = document.createElement("div");
    var fullbleed = mapElement.parentNode;
    controls.className = "porchfest-map-controls";

    var toolbar = document.createElement("div");
    toolbar.className = "porchfest-map-toolbar";
    toolbar.appendChild(
      createHourControl(status, listSection, venues, markerLookup),
    );
    toolbar.appendChild(createSortButton(listSection, venues));
    controls.appendChild(toolbar);
    controls.appendChild(
      createGenreFacet(status, listSection, venues, markerLookup),
    );

    fullbleed.appendChild(status);
    fullbleed.appendChild(mapElement);
    // Filters read as a header for the lineup they filter, so they sit between
    // the map and the venue list rather than above the map.
    listSection.parentNode.insertBefore(controls, listSection);
  }

  function showVenueOnMap(venue) {
    var marker = markersByVenueKey[venueKey(venue)];
    if (!map || !marker) return;

    if (pendingCardPopupHandler) map.off("moveend", pendingCardPopupHandler);
    pendingCardPopupHandler = function () {
      pendingCardPopupHandler = null;
      marker.openPopup();
    };
    map.once("moveend", pendingCardPopupHandler);
    map.flyTo([venue.lat, venue.lng], 17, { duration: 0.5 });
  }

  function appendShowOnMapButton(parent, venue) {
    var title = cleanText(venue && venue.title) || "Porchfest venue";
    var button = document.createElement("button");
    button.className = "porchfest-show-on-map";
    button.setAttribute("type", "button");
    button.setAttribute("aria-label", "Show " + title + " on map");
    button.textContent = "Map";
    button.addEventListener("click", function () {
      showVenueOnMap(venue);
    });
    parent.appendChild(button);
  }

  function appendVenueContent(container, venue) {
    var title = cleanText(venue.title) || "Porchfest venue";
    var address = cleanText(venue.address);

    var venueBand = document.createElement("div");
    venueBand.className = "porchfest-venue-band";
    container.appendChild(venueBand);

    appendTextElement(venueBand, "h3", "porchfest-venue-title", title);
    if (
      address &&
      normalizedWhitespace(address) !== normalizedWhitespace(title)
    ) {
      appendTextElement(
        venueBand,
        "address",
        "porchfest-venue-address",
        address,
      );
    }
    var acts = document.createElement("ul");
    acts.className = "porchfest-venue-acts";
    venueActs(venue).forEach(function (act) {
      acts.appendChild(createActContent(act, "h4"));
    });
    container.appendChild(acts);
    return venueBand;
  }

  function createPopupContent(venue) {
    var popup = document.createElement("article");
    popup.className = "porchfest-map-popup";

    appendVenueContent(popup, venue);
    return popup;
  }

  function createMarkerIcon() {
    var pin = document.createElement("span");
    pin.className = "porchfest-marker-pin";
    pin.setAttribute("aria-hidden", "true");

    var note = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    note.setAttribute("class", "porchfest-marker-note");
    note.setAttribute("viewBox", "0 0 24 24");
    note.setAttribute("aria-hidden", "true");
    note.setAttribute("focusable", "false");

    var notePath = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "path",
    );
    notePath.setAttribute("d", "M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z");
    note.appendChild(notePath);
    pin.appendChild(note);

    return L.divIcon({
      className: "porchfest-marker-shell",
      html: pin,
      iconSize: [44, 44],
      iconAnchor: [22, 40],
      popupAnchor: [0, -38],
    });
  }

  function assertVenueCoordinates(venues) {
    venues.forEach(function (venue) {
      if (
        !venue ||
        !Number.isFinite(venue.lat) ||
        !Number.isFinite(venue.lng)
      ) {
        throw new Error("Venue data contains invalid coordinates.");
      }
    });
  }

  function popupMaxWidth() {
    var viewportWidth = Number(window.innerWidth);
    if (!Number.isFinite(viewportWidth)) return 320;
    return Math.max(1, Math.min(320, viewportWidth - 32));
  }

  function updateMarkerPopupWidth(marker, maxWidth) {
    var popup = marker.getPopup && marker.getPopup();
    if (!popup) return;

    popup.options.maxWidth = maxWidth;
    popup.options.minWidth = Math.min(260, maxWidth);
    if (popup.isOpen && popup.isOpen() && popup.update) popup.update();
  }

  function renderMap(mapElement, venues) {
    mapElement.hidden = false;

    var renderedMap = L.map(mapElement, { scrollWheelZoom: false });
    try {
      L.tileLayer(TILE_URL, {
        attribution: TILE_ATTRIBUTION,
        maxZoom: 19,
      }).addTo(renderedMap);

      var bounds = L.latLngBounds([]);
      var markers = [];
      var markerLookup = Object.create(null);
      var initialPopupMaxWidth = popupMaxWidth();
      venues.forEach(function (venue) {
        var venueTitle = cleanText(venue.title) || "Porchfest venue";
        var popupContent = null;
        var marker = L.marker([venue.lat, venue.lng], {
          icon: createMarkerIcon(),
          keyboard: true,
          title: venueTitle,
        }).addTo(renderedMap);

        marker.bindPopup(
          function () {
            if (!popupContent) popupContent = createPopupContent(venue);
            return popupContent;
          },
          {
            maxWidth: initialPopupMaxWidth,
            minWidth: Math.min(260, initialPopupMaxWidth),
            autoPan: true,
            autoPanPadding: [24, 24],
          },
        );
        markers.push(marker);
        markerLookup[venueKey(venue)] = marker;

        bounds.extend([venue.lat, venue.lng]);
      });

      function updatePopupWidths() {
        var maxWidth = popupMaxWidth();
        markers.forEach(function (marker) {
          updateMarkerPopupWidth(marker, maxWidth);
        });
      }

      renderedMap.on("resize", updatePopupWidths);
      window.addEventListener("orientationchange", function () {
        window.requestAnimationFrame(function () {
          renderedMap.invalidateSize();
        });
      });

      renderedMap.fitBounds(bounds, {
        padding: [28, 28],
        maxZoom: 16,
      });
      markers.forEach(function (marker, index) {
        var markerElement = marker.getElement();
        if (!markerElement) return;

        var venueTitle = cleanText(venues[index].title) || "Porchfest venue";
        markerElement.setAttribute("role", "button");
        markerElement.setAttribute("aria-label", venueTitle + ": show lineup");
        markerElement.tabIndex = 0;
        markerElement.addEventListener("keydown", function (event) {
          if (event.key === " " || event.key === "Spacebar") {
            event.preventDefault();
            marker.openPopup();
          }
        });
      });
      return {
        map: renderedMap,
        markersByVenueKey: markerLookup,
      };
    } catch (error) {
      renderedMap.remove();
      throw error;
    }
  }

  function renderVenueList(listSection, venues) {
    var list = listSection.querySelector(".porchfest-venue-list-items");
    var fragment = document.createDocumentFragment();

    venues.forEach(function (venue) {
      var item = document.createElement("li");
      item.className = "porchfest-venue-card";
      item.dataset.venueKey = venueKey(venue);

      var venueBand = appendVenueContent(item, venue);
      appendShowOnMapButton(venueBand, venue);
      fragment.appendChild(item);
    });

    list.appendChild(fragment);
    listSection.hidden = false;
  }

  function showState(status, mapElement, listSection, message, className) {
    mapElement.hidden = true;
    listSection.hidden = true;
    status.hidden = false;
    status.className = "porchfest-map-status " + className;
    status.textContent = message;
  }

  function fetchMapData() {
    var controller = new window.AbortController();
    var timeoutId = window.setTimeout(function () {
      controller.abort();
    }, DATA_TIMEOUT_MS);

    return window
      .fetch(DATA_URL, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      })
      .then(function (response) {
        if (!response.ok) throw new Error("Map data request failed.");
        return response.json();
      })
      .then(
        function (payload) {
          window.clearTimeout(timeoutId);
          return payload;
        },
        function (error) {
          window.clearTimeout(timeoutId);
          throw error;
        },
      );
  }

  function init() {
    var mount = document.querySelector(".porchfest-map-mount");
    if (!mount || mount.dataset.enhanced) return;
    mount.dataset.enhanced = "1";

    var status = mount.querySelector(".porchfest-map-status");
    var mapElement = mount.querySelector(".porchfest-map-canvas");
    var listSection = mount.querySelector(".porchfest-venue-list");
    if (!window.fetch || !window.L || !window.AbortController) {
      showState(
        status,
        mapElement,
        listSection,
        "The interactive map could not be loaded. Please refresh the page and try again.",
        "is-error",
      );
      return;
    }

    fetchMapData()
      .then(function (payload) {
        var venues =
          payload && Array.isArray(payload.venues) ? payload.venues : null;
        if (!venues) throw new Error("Map data has an unexpected shape.");

        var hasActs = venues.some(function (venue) {
          return venueActs(venue).length > 0;
        });
        if (!hasActs) {
          showState(
            status,
            mapElement,
            listSection,
            "No map is published yet. Please check back closer to the event.",
            "is-empty",
          );
          return;
        }

        assertVenueCoordinates(venues);
        renderVenueList(listSection, venues);
        sortVenueCards(listSection, venues, viewState.sortDirection);
        var rendered = renderMap(mapElement, venues);
        map = rendered.map;
        markersByVenueKey = rendered.markersByVenueKey;
        renderMapControls(
          mapElement,
          status,
          listSection,
          venues,
          markersByVenueKey,
        );
        applyView(status, listSection, venues, markersByVenueKey);
        watchVenueLayout(listSection);
      })
      .catch(function () {
        showState(
          status,
          mapElement,
          listSection,
          "The interactive map could not be loaded. Please refresh the page and try again.",
          "is-error",
        );
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
