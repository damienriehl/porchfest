import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function timestamp(kind: "host" | "performer", index: number): string {
  const hour = kind === "host" ? "10" : "11";
  return `2026-05-${String(index).padStart(2, "0")}T${hour}:00:00Z`;
}

function host(index: number) {
  const suffix = String(index).padStart(2, "0");
  const ts = timestamp("host", index);
  return {
    _row: index + 1,
    timestamp: ts,
    ts,
    contact_name: `Synthetic Host ${suffix}`,
    contact_email: `host-${suffix}@example.invalid`,
    contact_phone: `synthetic-host-phone-${suffix}`,
    secondary_contact_name: index % 6 === 0 ? `Co-host ${suffix}` : "",
    secondary_contact_phone:
      index % 6 === 0 ? `synthetic-cohost-phone-${suffix}` : "",
    address: `${100 + index} Lantern Loop, Fableton, FS`,
    property_part: index % 2 === 0 ? "front garden" : "side terrace",
    space_type: index % 3 === 0 ? "covered platform" : "open lawn",
    electrical: index % 4 === 0 ? "No" : "Yes",
    enclosed: index % 5 === 0 ? "Yes" : "No",
    canopy: index % 5 === 1 ? "Yes" : "No",
    gear:
      index === 1
        ? "PA, moon harp"
        : index % 3 === 0
          ? "PA, microphone stand"
          : "extension cord",
    gear_details: index % 4 === 0 ? "A small mixer is available." : "",
    drinks: index % 2 === 0 ? "water, non-alcoholic drinks" : "water",
    amenities: index % 2 === 0 ? "seating, shade" : "restroom",
    wanted_bands: index % 4 === 0 ? "Acoustic or folk acts" : "",
    notes: `Invented host note ${suffix}.`,
  };
}

function performer(index: number) {
  const suffix = String(index).padStart(2, "0");
  const ts = timestamp("performer", index);
  return {
    _row: index + 1,
    timestamp: ts,
    ts,
    contact_name: `Synthetic Performer ${suffix}`,
    email: `performer-${suffix}@example.invalid`,
    phone: `synthetic-performer-phone-${suffix}`,
    band: `Lantern Ensemble ${suffix}`,
    duration: index % 3 === 0 ? "45 minutes" : "60 minutes",
    slots: index % 4 === 0 ? "6-7" : "6-7, 7-8",
    amplification: index % 2 === 0 ? "Small amplifier" : "None",
    genres: index % 2 === 0 ? "folk / jazz" : "indie pop",
    description: `Invented act description ${suffix}.`,
    listen:
      index === 7
        ? `https://audio.example.invalid/ensemble-${suffix} ask for the demo track`
        : index % 5 === 0
          ? "none"
          : `https://audio.example.invalid/ensemble-${suffix}`,
    websites:
      index === 7 ? "n/a" : `https://bands.example.invalid/ensemble-${suffix}`,
    house_pref: index % 3 === 0 ? "A shaded space" : "",
    lend_gear: index % 4 === 0 ? "Microphone" : "None",
    lend_gear_details:
      index === 7
        ? "An invented crystal pickup."
        : index % 4 === 0
          ? "One wired microphone."
          : "",
    overlaps:
      index % 8 === 0 ? "Shares a member with another invented act." : "",
    notes: `Invented performer note ${suffix}.`,
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function generateSeasonFixture(outputDirectory = here): void {
  const hosts = Array.from({ length: 23 }, (_, index) => host(index + 1));
  const performers = Array.from({ length: 27 }, (_, index) =>
    performer(index + 1),
  );
  const matchedHostIndexes = [
    1,
    3,
    ...Array.from({ length: 18 }, (_, i) => i + 5),
  ];
  const assignedPerformerIndexes = [
    1,
    ...Array.from({ length: 19 }, (_, i) => i + 3),
  ];
  const realVenues = matchedHostIndexes.map((hostIndex, position) => {
    const hostRow = hosts[hostIndex - 1]!;
    const performerRow = performers[assignedPerformerIndexes[position]! - 1]!;
    const slotTwo =
      position === 2 || position === 3
        ? {
            virtual_performer: `virtual-act-${position}`,
            ...(position === 3
              ? { note: "Invented virtual performer slot note." }
              : {}),
          }
        : position >= 15 && position <= 18
          ? { open: true }
          : { same_as: "6-7" };
    const withdrawn =
      position < 2
        ? {
            on: `2026-08-${String(position + 10).padStart(2, "0")}`,
            reason: `Invented physical venue withdrawal ${position + 1}.`,
          }
        : undefined;
    const mapAddress =
      position === 2 || position === 3
        ? `${700 + position} Storybook Square, Fableton, FS`
        : undefined;
    return {
      id: `venue-${String(position + 1).padStart(2, "0")}`,
      host_ts: hostRow.ts,
      ...(mapAddress ? { map_address: mapAddress } : {}),
      address_check: mapAddress ?? hostRow.address,
      basis: `Invented matching basis ${position + 1}.`,
      chase: [`Invented chase item ${position + 1}.`],
      email_notes: [`Invented email note ${position + 1}.`],
      extra_recipients:
        position === 0
          ? ["manual_contact: manual-extra-one"]
          : position === 1
            ? ["manual_contact: manual-extra-two"]
            : [],
      ...(withdrawn ? { withdrawn } : {}),
      slots: {
        "6-7": {
          performer_ts: performerRow.ts,
          ...(withdrawn
            ? {
                canceled: {
                  on: withdrawn.on,
                  reason: `Invented canceled assignment ${position + 1}.`,
                },
              }
            : {}),
          ...(position === 2
            ? { band_check: "Invented organizer name verification." }
            : {}),
        },
        "7-8": slotTwo,
      },
    };
  });

  const virtualVenues = {
    "virtual-hold-venue": {
      address_display: "901 Moonbeam Mews, Fableton, FS",
      host_display_name: "Synthetic Hold Host",
      reach_via_performer_ts: performers[0]!.ts,
      note: "Invented act-side hold venue note.",
    },
    "virtual-withdrawn-venue": {
      address_display: "902 Moonbeam Mews, Fableton, FS",
      host_display_name: "Synthetic Withdrawn Host",
      reach_via_performer_ts: performers[2]!.ts,
      note: "Invented withdrawn venue note.",
      withdrawn: {
        on: "2026-08-15",
        reason: "Invented placeholder withdrawal reason.",
      },
    },
  };
  const venueEntries = [
    ...realVenues,
    {
      id: "virtual-hold-venue",
      virtual_venue: "virtual-hold-venue",
      address_check: virtualVenues["virtual-hold-venue"].address_display,
      basis: "Invented basis for the act-side hold.",
      chase: ["Invented chase for the held venue."],
      email_notes: ["Invented held-venue email note."],
      slots: {
        "6-7": {
          held_for_virtual_performer: "virtual-act-1",
          decide_by: "2026-09-01",
          id_for_fallback: "venue-01",
        },
        "7-8": { open: true },
      },
    },
    {
      id: "virtual-withdrawn-venue",
      virtual_venue: "virtual-withdrawn-venue",
      address_check: virtualVenues["virtual-withdrawn-venue"].address_display,
      basis: "Invented basis for the withdrawn placeholder.",
      chase: ["Invented chase for the withdrawn placeholder."],
      email_notes: ["Invented withdrawn-venue email note."],
      withdrawn: virtualVenues["virtual-withdrawn-venue"].withdrawn,
      slots: {
        "6-7": {
          performer_ts: performers[21]!.ts,
          canceled: {
            on: "2026-08-15",
            reason: "Invented canceled virtual-venue assignment.",
          },
        },
        "7-8": { same_as: "6-7" },
      },
    },
  ];

  const virtualPerformers = Object.fromEntries(
    Array.from({ length: 6 }, (_, index) => {
      const number = index + 1;
      return [
        `virtual-act-${number}`,
        number === 1
          ? {
              display_name: "Paper Comet Collective",
              reach_via: "manual_contact",
              manual_contact: "manual-paper-comet",
              note: "Invented manual-contact placeholder note.",
            }
          : number <= 3
            ? {
                display_name: `Porcelain Echo ${number}`,
                reach_via: "host",
                note: `Invented host-reached placeholder note ${number}.`,
              }
            : {
                display_name: `Porcelain Echo ${number}`,
                reach_via: performers[number + 15]!.ts,
                note: `Invented timestamp-reached placeholder note ${number}.`,
              },
      ];
    }),
  );

  const overrideSpecs = [
    { index: 3, field: "band", value: "Lantern Ensemble Three Revised" },
    {
      index: 5,
      field: "email",
      value: "performer-05-revised@example.invalid",
    },
    {
      index: 7,
      field: "listen",
      value:
        "https://revised-audio.example.invalid/ensemble-07 revised demo note",
    },
    { index: 9, field: "websites", value: "-" },
  ] as const;
  const overrides = overrideSpecs.map(({ index, field, value }) => {
    const row = performers[index - 1]!;
    return [
      row.ts,
      {
        on: `2026-08-${String(index).padStart(2, "0")}`,
        reason: `Invented override reason ${index}.`,
        fields: { [field]: { original: row[field], value } },
      },
    ];
  });

  const matches = {
    _comment: "Entirely synthetic Goal-1-shaped fixture.",
    event: {
      name: "Fableton Lantern Porchfest 2026",
      date: "2026-09-16",
      date_display: "September 16, 2026",
      city: "Fableton",
      state: "FS",
      time_display: "6–8 pm",
      website: "https://porchfest.example.invalid",
      map_url: "https://map.example.invalid",
      host_form_url: "https://forms.example.invalid/hosts",
      performer_form_url: "https://forms.example.invalid/performers",
      organizer_name: "Synthetic Organizer",
      organizer_phone: "synthetic-organizer-phone",
      organizer_signature: "Synthetic organizing team",
    },
    venues: venueEntries,
    unmatched_venues: [
      {
        host_ts: hosts[22]!.ts,
        id_for_fallback: "unmatched-venue-override",
        address_check: hosts[22]!.address,
        status: "unmatched",
        email_note: "Invented unmatched venue note.",
      },
    ],
    floating_performers: [
      {
        performer_ts: performers[26]!.ts,
        status: "floating",
        status_display: "Invented floating performer status.",
        email_notes: ["Invented floating performer note."],
        action: "No action beyond the synthetic fixture.",
      },
    ],
    superseded: {
      hosts: {
        [hosts[1]!.ts]: {
          canonical: hosts[0]!.ts,
          reason: "Invented corrected host submission.",
        },
        [hosts[3]!.ts]: {
          canonical: hosts[2]!.ts,
          reason: "Invented duplicate host submission.",
        },
      },
      performers: {
        [performers[1]!.ts]: {
          canonical: performers[0]!.ts,
          reason: "Invented corrected performer submission.",
        },
      },
    },
    performer_overrides: Object.fromEntries(overrides),
    virtual_performers: virtualPerformers,
    virtual_venues: virtualVenues,
    manual_contacts: {
      "manual-paper-comet": {
        display_name: "Synthetic Manual Contact",
        email: "manual-paper-comet@example.invalid",
        source: "2025 Archive Tab",
      },
      "manual-extra-one": {
        display_name: "Synthetic Extra Recipient One",
        email: "manual-extra-one@example.invalid",
        source: "2025 Hosts Archive Tab",
      },
      "manual-extra-two": {
        display_name: "Synthetic Extra Recipient Two",
        email: "manual-extra-two@example.invalid",
        source: "2025 Performers Archive Tab",
      },
    },
    geocode_unimproved_allowlist: {},
  };

  const geocacheAddresses = [
    ...venueEntries.map((venue) => venue.address_check),
    hosts[22]!.address,
  ];
  const geocache = Object.fromEntries(
    geocacheAddresses.map((address, index) => [
      address,
      {
        lat: Number((10 + index * 0.01).toFixed(6)),
        lng: Number((20 + index * 0.01).toFixed(6)),
        source:
          index === 21
            ? "us-census-unimproved"
            : index >= 2 && index <= 4
              ? "nominatim-house"
              : "osm-address-point",
        ref: `way/${1000 + index}`,
        crosscheck_m: index >= 2 && index <= 4 ? null : 4.2,
      },
    ]),
  );

  writeJson(join(outputDirectory, "synthetic.submissions.json"), {
    hosts,
    performers,
  });
  writeJson(join(outputDirectory, "slate.synthetic.json"), matches);
  writeJson(join(outputDirectory, "synthetic.geocache.json"), geocache);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  generateSeasonFixture(process.argv[2] ? resolve(process.argv[2]) : here);
}
